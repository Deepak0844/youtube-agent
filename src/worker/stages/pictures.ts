import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type pg from "pg";
import { systemRightsText } from "@/server/core/asset-rules";
import { canonicalJson, sha256Hex } from "@/server/core/content-hash";
import { presetOf } from "../../../remotion/kit/presets";
import { clipBudget, countClipLinks, MAX_CLIPS_PER_VIDEO, type ClipCandidate, rankClips, wantsMotion } from "@/server/core/clip-rank";
import { rankCandidates, type PictureBrief, type PictureCandidate } from "@/server/core/picture-rank";
import type { StageHandler } from "@/server/core/stage-handler";
import { registerAsset } from "@/server/db/assets";
import { approvedScript } from "@/server/db/stage-content";
import { assetsForVideo, linkAsset, LinkRefused, unlinkStageBeats } from "@/server/db/video-assets";
import { parsePixabay, pixabaySearchUrl } from "@/server/providers/stock/pixabay-pictures";
import { parsePixabayVideos, pixabayVideoSearchUrl } from "@/server/providers/stock/pixabay-videos";
import {
  API_MAX_BYTES, createPacer, fetchBounded, IMAGE_TYPES, JSON_TYPE, PICTURE_MAX_BYTES, PIXABAY_API_HOSTS, PIXABAY_FILE_HOSTS, VIDEO_TYPE,
  WIKIMEDIA_API_HOSTS, WIKIMEDIA_FILE_HOSTS, type PictureFetcher,
} from "@/server/providers/stock/picture-download";
import { commonsSearchUrl, parseCommons } from "@/server/providers/stock/wikimedia";
import { ingestClip, ingestImage, type IngestDeps } from "@/server/render/ingest";
import { videoIdOf } from "./attempt";

export const MAX_BEATS = 12;
export const MAX_QUERIES = 2;
export const MAX_TRIES_PER_BEAT = 3;
/** The whole stage stops searching after this long and succeeds with what it has. */
export const DEADLINE_MS = 8 * 60_000;
const SEARCH_LIMIT = 12;

export interface PicturesDeps {
  db: pg.Pool;
  root: string;
  fetcher: PictureFetcher;
  /** Saved Pixabay key, or null/absent = Pixabay is skipped. Read per call, never logged. */
  pixabayKey?: () => Promise<string | null>;
  ingest: IngestDeps;
  /** Test seams. */
  ingestImageFn?: typeof ingestImage;
  ingestClipFn?: typeof ingestClip;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  /** Fires when the overall time budget is spent (default: 8 minutes). */
  deadline?: AbortSignal;
}

export interface BeatOutcome { beatId: string; found: boolean; source: string | null; licence: string | null; reason: string }

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(signal.reason ?? new Error("aborted")); };
    signal.addEventListener("abort", onAbort, { once: true });
  });

function briefOf(b: unknown): { text: string; visual: string; queries: string[]; raw: string[] } {
  const { text, visual, search } = (b ?? {}) as { text?: unknown; visual?: unknown; search?: unknown };
  const v = typeof visual === "string" ? visual.trim() : "";
  const raw = (Array.isArray(search) ? search : []).filter((x): x is string => typeof x === "string");
  const q = raw.filter((x) => x.trim() !== "").map((x) => x.trim().slice(0, 120));
  if (q.length === 0 && v) q.push(v.split(/\s+/).slice(0, 8).join(" "));
  return { text: typeof text === "string" ? text : "", visual: v, queries: q.slice(0, MAX_QUERIES), raw };
}

type Attempt = { ok: true; assetId: string; duplicate: boolean; bytes: number } | { ok: false; reason: string };
const sourceName = (s: PictureCandidate["source"]) => (s === "wikimedia" ? "Wikimedia Commons" : "Pixabay");

/**
 * Pictures: finds one free, licensed, relevant real picture per beat (Wikimedia Commons first, then Pixabay when a key is saved),
 * downloads it with the capped host-listed fetch, re-encodes it in the sandboxed ingest, stores it in the asset library and
 * links it to the beat with its credit line. Free: no money, no model. A beat with nothing acceptable gets no picture. Search
 * and download problems are recorded per beat and never fail the stage; neither does running out of time (the rest get
 * 'deadline'). Replay-safe: a beat whose link was made for the same brief is skipped; a changed brief re-picks. Links made by
 * hand (no brief hash) are never touched. A picture whose bytes match a TRASHED library asset is skipped, never revived.
 * The assets are registered with containsPerson=false only because portraits and person-tagged hits are refused upstream.
 */
export function picturesHandler(deps: PicturesDeps): StageHandler {
  return async (ctx) => {
    const videoId = videoIdOf(ctx);
    const script = await approvedScript(deps.db, videoId);
    if (!script.ok) return { beats: [] as BeatOutcome[], linked: 0, note: script.reason };
    const deadline = deps.deadline ?? AbortSignal.timeout(DEADLINE_MS);
    const signal = AbortSignal.any([ctx.signal, deadline]);
    const pace = createPacer({ minGapMs: 1000, now: deps.now ?? Date.now, sleep: deps.sleep ?? defaultSleep });

    const beats = script.beats.map((b, i) => {
      const brief = briefOf(b);
      return { id: typeof b?.id === "string" && b.id !== "" ? b.id : `beat-${i + 1}`, ...brief, hash: sha256Hex(canonicalJson({ text: brief.text, visual: brief.visual, search: brief.raw })) };
    });
    const existing = await assetsForVideo(deps.db, videoId);
    // Links the stage made for beats that are gone from the script go away (hand-made links stay).
    const live = new Set(beats.map((b) => b.id));
    await unlinkStageBeats(deps.db, videoId, [...new Set(existing.filter((l) => !live.has(l.beatId)).map((l) => l.beatId))]);
    const linksOf = (beatId: string) => existing.filter((l) => l.beatId === beatId);

    // A style may ask for clips on every beat and a higher clip cap (documentary_montage); everyone else keeps today's rules.
    const styleRow = await deps.db.query<{ style: string | null }>("select style from videos where id = $1", [videoId]);
    const clipRule = presetOf(styleRow.rows[0]?.style).clips ?? { wantAll: false, max: MAX_CLIPS_PER_VIDEO };

    const outcomes: BeatOutcome[] = [];
    let clips = countClipLinks(existing, live); // clip links on every live beat before the loop; a beat that is re-picked gives its clips back
    let clipBytes = 0; // real bytes of every clip download this run, kept or not
    let linked = 0;

    const getJson = async (url: string, hosts: readonly string[]): Promise<unknown> => {
      await pace(new URL(url).hostname, signal);
      const r = await fetchBounded(deps.fetcher, url, { hosts, maxBytes: API_MAX_BYTES, accept: JSON_TYPE, signal });
      if (!r.ok) return null;
      try { return JSON.parse(Buffer.from(r.bytes).toString("utf8")); } catch { return null; }
    };

    /** What one download needs: a picture or a clip (same safe fetch, sandboxed ingest, asset row and beat link). */
    interface Target { url: string; hosts: readonly string[]; maxBytes: number; accept: RegExp; acceptHeader?: string; clip: boolean; source: "pixabay" | "wikimedia"; title: string; licence: string; credit: string; pageUrl: string | null }
    const attempt = async (videoBeat: { id: string; hash: string }, c: Target): Promise<Attempt> => {
      const tmpDir = path.join(deps.root, "assets-incoming");
      const src = path.join(tmpDir, `pf-${randomUUID()}`);
      const rel = `assets/${randomUUID()}`;
      const dest = path.join(deps.root, rel);
      let stored = false;
      try {
        let r;
        try {
          await pace(new URL(c.url).hostname, signal);
          const got = await fetchBounded(deps.fetcher, c.url, { hosts: c.hosts, maxBytes: c.clip ? clipBudget(clipBytes) : c.maxBytes, accept: c.accept, acceptHeader: c.acceptHeader, signal });
          if (!got.ok) {
            if (c.clip && got.reason === "too_big") clipBytes += c.maxBytes; // streamed up to the cap before refusing: count it all
            return { ok: false, reason: `download refused (${got.reason})` };
          }
          if (c.clip) clipBytes += got.bytes.length; // counted before ingest, so a refused or duplicate clip still uses the budget
          await mkdir(tmpDir, { recursive: true });
          await mkdir(dest, { recursive: true });
          await writeFile(src, got.bytes, { flag: "wx" });
          r = c.clip
            ? await (deps.ingestClipFn ?? ingestClip)(deps.ingest, { srcPath: src, destDir: dest, maxBytes: c.maxBytes, signal, stageRunId: ctx.claim.stageRunId })
            : await (deps.ingestImageFn ?? ingestImage)(deps.ingest, { srcPath: src, destDir: dest, maxBytes: c.maxBytes, signal, stageRunId: ctx.claim.stageRunId });
        } catch (e) {
          if (signal.aborted) throw e;
          return { ok: false, reason: c.clip ? "clip could not be fetched or checked" : "picture could not be fetched or checked" }; // a bad candidate never fails the stage
        }
        if (!r.ok) return { ok: false, reason: `${c.clip ? "clip" : "image"} refused (${r.reason})` };
        const refs = Object.fromEntries(Object.entries(r.files).map(([role, f]) => [role, `${rel}/${path.basename(f)}`]));
        const { main, ...derivedRefs } = refs;

        // One transaction: look the bytes up first. A trashed asset is never revived (registerAsset would clear its deletion).
        const client = await deps.db.connect();
        let assetId: string;
        let duplicate = false;
        try {
          await client.query("begin");
          const have = await client.query<{ id: string; kind: string; deleted_at: Date | null }>("select id, kind, deleted_at from assets where sha256 = $1 for update", [r.sha256]);
          const row = have.rows[0];
          if (row) {
            if (row.deleted_at !== null) { await client.query("rollback"); return { ok: false, reason: c.clip ? "clip was deleted from the library" : "picture was deleted from the library" }; }
            assetId = row.id;
            duplicate = true;
          } else {
            const reg = await registerAsset(client, {
              kind: c.clip ? "video" : "image", originalName: `${c.source}-${c.title}.${c.clip ? "mp4" : r.mime === "image/png" ? "png" : "jpg"}`.replace(/[^A-Za-z0-9._ -]/g, "_"), mime: r.mime, bytes: r.bytes,
              width: r.width, height: r.height, durationS: r.durationS, sha256: r.sha256, storageRef: main!, derivedRefs, tags: c.clip ? ["stock", c.source, "clip"] : ["stock", c.source], caption: c.title.slice(0, 500), source: "stock",
              rights: { attestations: [{ at: new Date().toISOString(), by: "system", text: systemRightsText(c.licence, sourceName(c.source)) }] }, containsPerson: false,
            });
            assetId = reg.asset.id;
            stored = true;
          }
          await client.query("commit");
        } catch (e) {
          await client.query("rollback").catch(() => undefined);
          throw e;
        } finally {
          client.release();
        }
        if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error("aborted"); // no link is written once the stage is cancelled
        try {
          await linkAsset(deps.db, { videoId, assetId, beatId: videoBeat.id, credit: c.credit, sourceUrl: c.pageUrl, licence: c.licence, briefHash: videoBeat.hash });
        } catch (e) {
          if (!(e instanceof LinkRefused)) throw e;
          return { ok: false, reason: c.clip ? "could not link the clip" : "could not link the picture" };
        }
        return { ok: true, assetId, duplicate, bytes: r.bytes };
      } finally {
        if (!stored) await rm(dest, { recursive: true, force: true }).catch(() => undefined);
        await rm(src, { force: true }).catch(() => undefined);
      }
    };

    let considered = 0;
    for (const beat of beats) {
      if (beat.queries.length === 0 && !beat.visual) continue;
      if (considered++ >= MAX_BEATS) break;
      const out = (found: boolean, reason: string, c?: { source?: string; licence: string }): void => {
        outcomes.push({ beatId: beat.id, found, source: c?.source ?? (c ? "pixabay" : null), licence: c?.licence ?? null, reason });
      };
      const mine = linksOf(beat.id);
      if (mine.some((l) => l.briefHash === null) || (mine.length > 0 && mine.every((l) => l.briefHash === beat.hash))) { out(true, "already linked"); continue; }
      if (deadline.aborted) { out(false, "deadline"); continue; }
      if (mine.length > 0) { clips -= countClipLinks(mine, new Set([beat.id])); await unlinkStageBeats(deps.db, videoId, [beat.id]); } // the brief changed: pick again
      ctx.progress?.(Math.round((outcomes.length / Math.min(MAX_BEATS, beats.length)) * 100));

      const brief: PictureBrief = { search: beat.queries, visual: beat.visual };
      let last = "no acceptable picture found";
      try {
        let tries = 0;
        let done = false;
        const sources: Array<() => Promise<PictureCandidate[]>> = [
          async () => { const all: PictureCandidate[] = []; for (const q of beat.queries) all.push(...parseCommons(await getJson(commonsSearchUrl(q, SEARCH_LIMIT), WIKIMEDIA_API_HOSTS))); return all; },
          async () => {
            const key = deps.pixabayKey ? await deps.pixabayKey() : null;
            if (!key) return [];
            const all: PictureCandidate[] = [];
            for (const q of beat.queries) all.push(...parsePixabay(await getJson(pixabaySearchUrl(q, key, SEARCH_LIMIT), PIXABAY_API_HOSTS)));
            return all;
          },
        ];
        // A beat whose visual describes motion tries a free Pixabay clip first (needs the saved key; at most MAX_CLIPS_PER_VIDEO per
        // video and CLIPS_TOTAL_MAX_BYTES per run). Nothing acceptable = the normal picture search below.
        if ((clipRule.wantAll || wantsMotion(beat.visual)) && clips < clipRule.max && clipBudget(clipBytes) > 0) {
          const key = deps.pixabayKey ? await deps.pixabayKey() : null;
          if (key) {
            const found: ClipCandidate[] = [];
            for (const q of beat.queries) found.push(...parsePixabayVideos(await getJson(pixabayVideoSearchUrl(q, key, SEARCH_LIMIT), PIXABAY_API_HOSTS)));
            let ctries = 0;
            for (const { cand } of rankClips(brief, found)) {
              if (ctries++ >= 2 || clipBudget(clipBytes) === 0) break;
              const a = await attempt(beat, { ...cand, hosts: PIXABAY_FILE_HOSTS, maxBytes: clipBudget(clipBytes), accept: VIDEO_TYPE, acceptHeader: "video/mp4", clip: true, source: "pixabay" });
              if (a.ok) {
                linked++; clips++;
                out(true, a.duplicate ? "linked clip (already in library)" : "linked clip", cand);
                done = true;
                break;
              }
              last = a.reason;
            }
          }
        }
        for (const source of done ? [] : sources) {
          for (const { cand } of rankCandidates(brief, await source())) {
            if (tries++ >= MAX_TRIES_PER_BEAT) break;
            const a = await attempt(beat, { ...cand, hosts: cand.source === "wikimedia" ? WIKIMEDIA_FILE_HOSTS : PIXABAY_FILE_HOSTS, maxBytes: PICTURE_MAX_BYTES, accept: IMAGE_TYPES, clip: false });
            if (a.ok) {
              linked++;
              out(true, a.duplicate ? "linked (picture already in library)" : "linked", cand);
              done = true;
              break;
            }
            last = a.reason;
          }
          if (done || tries >= MAX_TRIES_PER_BEAT) break;
        }
        if (!done) out(false, last);
      } catch (e) {
        if (ctx.signal.aborted) throw e;
        if (deadline.aborted) { out(false, "deadline"); continue; }
        throw e;
      }
    }
    return { beats: outcomes, linked };
  };
}

/** Dry run: finds nothing, links nothing, touches no network. */
export const dryRunPicturesHandler: StageHandler = async () => ({ beats: [] as BeatOutcome[], linked: 0, dryRun: true });
