import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type pg from "pg";
import { RIGHTS_TEXT } from "@/server/core/asset-rules";
import { pickBest, type PictureBrief, type PictureCandidate } from "@/server/core/picture-rank";
import type { StageHandler } from "@/server/core/stage-handler";
import { registerAsset } from "@/server/db/assets";
import { approvedScript } from "@/server/db/stage-content";
import { assetsForVideo, linkAsset, LinkRefused } from "@/server/db/video-assets";
import { parsePixabay, pixabaySearchUrl } from "@/server/providers/stock/pixabay-pictures";
import {
  API_MAX_BYTES, createPacer, fetchBounded, IMAGE_TYPES, JSON_TYPE, PICTURE_MAX_BYTES, PIXABAY_API_HOSTS, PIXABAY_FILE_HOSTS,
  WIKIMEDIA_API_HOSTS, WIKIMEDIA_FILE_HOSTS, type PictureFetcher,
} from "@/server/providers/stock/picture-download";
import { commonsSearchUrl, parseCommons } from "@/server/providers/stock/wikimedia";
import { ingestImage, type IngestDeps } from "@/server/render/ingest";
import { videoIdOf } from "./attempt";

export const MAX_BEATS = 12;
export const MAX_QUERIES = 2;
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
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
}

export interface BeatOutcome { beatId: string; found: boolean; source: string | null; licence: string | null; reason: string }

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(signal.reason ?? new Error("aborted")); };
    signal.addEventListener("abort", onAbort, { once: true });
  });

function briefOf(b: unknown): { visual: string; queries: string[] } {
  const { visual, search } = (b ?? {}) as { visual?: unknown; search?: unknown };
  const v = typeof visual === "string" ? visual.trim() : "";
  const q = (Array.isArray(search) ? search : []).filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim().slice(0, 120));
  if (q.length === 0 && v) q.push(v.split(/\s+/).slice(0, 8).join(" "));
  return { visual: v, queries: q.slice(0, MAX_QUERIES) };
}

/**
 * Pictures: finds one free, licensed, relevant real picture per beat (Wikimedia Commons first, then Pixabay when a key is saved),
 * downloads it with the capped host-listed fetch, re-encodes it in the sandboxed ingest, stores it in the asset library and
 * links it to the beat with its credit line. Free: no money, no model. A beat with nothing acceptable gets no picture. Search
 * and download problems are recorded per beat and never fail the stage. Replay-safe: a beat that already has a picture is skipped.
 */
export function picturesHandler(deps: PicturesDeps): StageHandler {
  return async (ctx) => {
    const videoId = videoIdOf(ctx);
    const script = await approvedScript(deps.db, videoId);
    if (!script.ok) return { beats: [] as BeatOutcome[], linked: 0, note: script.reason };
    const pace = createPacer({ minGapMs: 1000, now: deps.now ?? Date.now, sleep: deps.sleep ?? defaultSleep });
    const linkedBeats = new Set((await assetsForVideo(deps.db, videoId)).map((a) => a.beatId));
    const outcomes: BeatOutcome[] = [];
    let linked = 0;

    const getJson = async (url: string, hosts: readonly string[]): Promise<unknown> => {
      const host = new URL(url).hostname;
      await pace(host, ctx.signal);
      const r = await fetchBounded(deps.fetcher, url, { hosts, maxBytes: API_MAX_BYTES, accept: JSON_TYPE, signal: ctx.signal });
      if (!r.ok) return null;
      try { return JSON.parse(Buffer.from(r.bytes).toString("utf8")); } catch { return null; }
    };

    const beats = script.beats.map((b, i) => ({ id: typeof b?.id === "string" && b.id !== "" ? b.id : `beat-${i + 1}`, ...briefOf(b) }));
    let considered = 0;
    for (const beat of beats) {
      if (beat.queries.length === 0 && !beat.visual) continue;
      if (considered++ >= MAX_BEATS) break;
      const out = (found: boolean, reason: string, c?: PictureCandidate): void => {
        outcomes.push({ beatId: beat.id, found, source: c?.source ?? null, licence: c?.licence ?? null, reason });
      };
      if (linkedBeats.has(beat.id)) { out(true, "already linked"); continue; }
      ctx.progress?.(Math.round((outcomes.length / Math.min(MAX_BEATS, beats.length)) * 100));

      const brief: PictureBrief = { search: beat.queries, visual: beat.visual };
      let best = null as ReturnType<typeof pickBest>;
      const wiki: PictureCandidate[] = [];
      for (const q of beat.queries) wiki.push(...parseCommons(await getJson(commonsSearchUrl(q, SEARCH_LIMIT), WIKIMEDIA_API_HOSTS)));
      best = pickBest(brief, wiki);
      if (!best && deps.pixabayKey) {
        const key = await deps.pixabayKey();
        if (key) {
          const pix: PictureCandidate[] = [];
          for (const q of beat.queries) pix.push(...parsePixabay(await getJson(pixabaySearchUrl(q, key, SEARCH_LIMIT), PIXABAY_API_HOSTS)));
          best = pickBest(brief, pix);
        }
      }
      if (!best) { out(false, "no acceptable picture found"); continue; }
      const c = best.cand;

      const tmpDir = path.join(deps.root, "assets-incoming");
      const src = path.join(tmpDir, `pf-${randomUUID()}`);
      const rel = `assets/${randomUUID()}`;
      const dest = path.join(deps.root, rel);
      let stored = false;
      try {
        await pace(new URL(c.url).hostname, ctx.signal);
        const got = await fetchBounded(deps.fetcher, c.url, { hosts: c.source === "wikimedia" ? WIKIMEDIA_FILE_HOSTS : PIXABAY_FILE_HOSTS, maxBytes: PICTURE_MAX_BYTES, accept: IMAGE_TYPES, signal: ctx.signal });
        if (!got.ok) { out(false, `download refused (${got.reason})`, c); continue; }
        await mkdir(tmpDir, { recursive: true });
        await mkdir(dest, { recursive: true });
        await writeFile(src, got.bytes, { flag: "wx" });
        let r;
        try {
          r = await (deps.ingestImageFn ?? ingestImage)(deps.ingest, { srcPath: src, destDir: dest, maxBytes: PICTURE_MAX_BYTES, signal: ctx.signal, stageRunId: ctx.claim.stageRunId });
        } catch (e) {
          if (ctx.signal.aborted) throw e;
          out(false, "image check failed", c);
          continue;
        }
        if (!r.ok) { out(false, `image refused (${r.reason})`, c); continue; }
        const refs = Object.fromEntries(Object.entries(r.files).map(([role, f]) => [role, `${rel}/${path.basename(f)}`]));
        const { main, ...derivedRefs } = refs;
        const reg = await registerAsset(deps.db, {
          kind: "image", originalName: `${c.source}-${c.title}.${r.mime === "image/png" ? "png" : "jpg"}`.replace(/[^A-Za-z0-9._ -]/g, "_"), mime: r.mime, bytes: r.bytes,
          width: r.width, height: r.height, sha256: r.sha256, storageRef: main!, derivedRefs, tags: ["stock", c.source], caption: c.title.slice(0, 500), source: "stock",
          rights: { attestations: [{ at: new Date().toISOString(), text: RIGHTS_TEXT }] }, containsPerson: false,
        });
        stored = !reg.duplicate;
        if (reg.duplicate) await rm(dest, { recursive: true, force: true }).catch(() => undefined); // the first copy's files stay
        try {
          await linkAsset(deps.db, { videoId, assetId: reg.asset.id, beatId: beat.id, credit: c.credit, sourceUrl: c.pageUrl, licence: c.licence });
        } catch (e) {
          if (!(e instanceof LinkRefused)) throw e;
          out(false, "could not link the picture", c);
          continue;
        }
        linked++;
        out(true, reg.duplicate ? "linked (picture already in library)" : "linked", c);
      } finally {
        if (!stored) await rm(dest, { recursive: true, force: true }).catch(() => undefined);
        await rm(src, { force: true }).catch(() => undefined);
      }
    }
    return { beats: outcomes, linked };
  };
}

/** Dry run: finds nothing, links nothing, touches no network. */
export const dryRunPicturesHandler: StageHandler = async () => ({ beats: [] as BeatOutcome[], linked: 0, dryRun: true });
