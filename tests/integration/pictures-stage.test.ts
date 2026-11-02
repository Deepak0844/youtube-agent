import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildEngineConfig } from "@/server/core/engine-config";
import { canonicalJson, sha256Hex } from "@/server/core/content-hash";
import { uuidv7 } from "@/server/core/ids";
import { buildSceneDoc } from "@/server/core/scene-build";
import { createStageContext } from "@/server/core/stage-handler";
import { approveGate, liveGateHash } from "@/server/db/approvals";
import { createPgPaidCallPorts } from "@/server/db/paid-call-adapter";
import { claimStage, insertQueuedStage } from "@/server/db/stages";
import { assetsForVideo, creditsForVideo, unlinkAll } from "@/server/db/video-assets";
import { addContent, createVideoRow } from "@/server/db/videos";
import { fakeDraft } from "@/server/llm/fake-step";
import { picturesHandler, type PicturesDeps } from "@/worker/stages/pictures";
import { withTestDb, type TestDb } from "../support/db";

let db: TestDb;
let root: string;
const config = buildEngineConfig(new Map());
const SESSION = { kind: "session", sessionId: "11111111-1111-4111-8111-111111111111" } as const;
beforeAll(async () => {
  db = await withTestDb();
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "pictures-")));
});
afterAll(async () => {
  rmSync(root, { recursive: true, force: true });
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
});

const BEATS = [
  { id: "b1", text: "x", visual: "cutaway diagram of a petrol engine", search: ["petrol engine cutaway"] },
  { id: "b2", text: "y", visual: "a purple zebra on the moon", search: ["purple zebra moon"] },
  { id: "b3", text: "z" },
];

async function seed(): Promise<string> {
  const v = await createVideoRow(db.pool, { format: "short", kind: "scene_kit", language: "en", topic: "engines" });
  const d = fakeDraft("en") as { title: string; narration: string };
  await addContent(db.pool, v.id, "script", { body: { title: d.title, narration: d.narration }, sha256: sha256Hex(canonicalJson(d)) });
  const b = { beats: BEATS };
  await addContent(db.pool, v.id, "beats", { body: b, sha256: sha256Hex(canonicalJson(b)) });
  const live = await liveGateHash(db.pool, v.id, "script");
  const r = await approveGate(db.pool, { videoId: v.id, gate: "script", seenHash: live!.hash, actor: SESSION });
  if (!r.ok) throw new Error(r.reason);
  return v.id;
}

async function ctxFor(videoId: string) {
  const inputHash = `h-${uuidv7()}`;
  const stageId = await insertQueuedStage(db.pool, { videoId, name: "pictures", inputHash });
  const claim = (await claimStage(db.pool, { id: stageId, inputHash, workerId: "w1", ttlMs: 600_000 }))!;
  return createStageContext({ stage: { id: stageId, name: "pictures", inputHash, videoId }, claim, config, signal: new AbortController().signal, paid: createPgPaidCallPorts(db.pool) }).ctx;
}

const page = (title: string, licence: string, w = 3000, h = 2000) => ({
  title: `File:${title}.jpg`, index: 1,
  imageinfo: [{
    url: `https://upload.wikimedia.org/wikipedia/commons/a/ab/${encodeURIComponent(title)}.jpg`, thumburl: `https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/${encodeURIComponent(title)}.jpg/1280px-x.jpg`,
    width: w, height: h, mime: "image/jpeg", descriptionurl: `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(title)}.jpg`,
    extmetadata: { Artist: { value: '<a href="//x">Jane Doe</a>' }, LicenseShortName: { value: licence }, ImageDescription: { value: "engine" }, Categories: { value: "Cutaways" } },
  }],
});
const json = (pages: unknown[]) => new Response(JSON.stringify({ query: { pages: Object.fromEntries(pages.map((p, i) => [String(i), p])) } }), { headers: { "content-type": "application/json" } });

interface Fake { deps: PicturesDeps; urls: string[] }
function mk(over: { api?: (q: string) => Response; file?: () => Response; throws?: boolean } = {}): Fake {
  const urls: string[] = [];
  const api = over.api ?? ((q) => (q.includes("petrol") ? json([page("Petrol engine cutaway", "CC BY 4.0")]) : json([])));
  const deps: PicturesDeps = {
    db: db.pool, root,
    fetcher: async (url) => {
      urls.push(url);
      if (over.throws) throw new Error("offline");
      const u = new URL(url);
      if (u.hostname === "commons.wikimedia.org") return api(u.searchParams.get("gsrsearch") ?? "");
      return over.file ? over.file() : new Response(new Uint8Array([1, 2, 3, 4]), { headers: { "content-type": "image/jpeg" } });
    },
    ingest: { runChild: async () => { throw new Error("not used"); } },
    ingestImageFn: async (_d, a) => ({
      ok: true, kind: "image", mime: "image/jpeg", width: 1280, height: 853, durationS: null, bytes: 4, originalBytes: 4,
      sha256: createHash("sha256").update("same-bytes").digest("hex"), files: { main: path.join(a.destDir, "main.jpg") },
    }),
    sleep: async () => undefined,
  };
  return { deps, urls };
}
const run = async (f: Fake, videoId: string) => (await picturesHandler(f.deps)(await ctxFor(videoId))) as { beats: Array<{ beatId: string; found: boolean; licence: string | null; reason: string }>; linked: number };

describe("pictures stage", () => {
  it("links the matching picture with its credit, gives a beat with no match nothing, skips a beat with no brief", async () => {
    const v = await seed();
    const out = await run(mk(), v);
    expect(out.linked).toBe(1);
    expect(out.beats).toMatchObject([{ beatId: "b1", found: true, licence: "CC BY 4.0" }, { beatId: "b2", found: false }]);
    const links = await assetsForVideo(db.pool, v);
    expect(links).toHaveLength(1);
    expect(links[0]!.beatId).toBe("b1");
    expect(links[0]!.credit).toContain("Jane Doe");
    expect(links[0]!.credit).toContain("CC BY 4.0");
    expect(await creditsForVideo(db.pool, v)).toHaveLength(1);
    const asset = (await db.pool.query("select source, kind from assets")).rows[0];
    expect(asset).toMatchObject({ source: "stock", kind: "image" });
    const link = (await db.pool.query("select licence, source_url from video_assets")).rows[0];
    expect(link.licence).toBe("CC BY 4.0");
    expect(link.source_url).toMatch(/^https:\/\/commons\.wikimedia\.org\/wiki\//);
  });

  it("replay does not duplicate links and does not download again", async () => {
    const v = await seed();
    await run(mk(), v);
    const again = mk();
    const out = await run(again, v);
    expect(out.linked).toBe(0);
    expect(out.beats[0]).toMatchObject({ beatId: "b1", found: true, reason: "already linked" });
    expect(await assetsForVideo(db.pool, v)).toHaveLength(1);
    expect(again.urls.some((u) => u.includes("upload.wikimedia.org"))).toBe(false);
  });

  it("reuses the library asset when the same bytes come again (no second row)", async () => {
    const v = await seed();
    await run(mk(), v);
    await unlinkAll(db.pool, v);
    await run(mk(), v);
    expect(Number((await db.pool.query("select count(*) n from assets")).rows[0].n)).toBe(1);
    expect(await assetsForVideo(db.pool, v)).toHaveLength(1);
  });

  it("succeeds with no pictures when the network fails", async () => {
    const v = await seed();
    const out = await run(mk({ throws: true }), v);
    expect(out.linked).toBe(0);
    expect(out.beats.every((b) => !b.found)).toBe(true);
    expect(await assetsForVideo(db.pool, v)).toEqual([]);
  });

  it("refuses share-alike pictures and bad downloads", async () => {
    const v = await seed();
    const sa = await run(mk({ api: () => json([page("Petrol engine cutaway", "CC BY-SA 4.0")]) }), v);
    expect(sa.linked).toBe(0);
    const html = await run(mk({ file: () => new Response("<html>", { headers: { "content-type": "text/html" } }) }), v);
    expect(html.beats[0]).toMatchObject({ found: false, reason: "download refused (type)" });
    const big = await run(mk({ file: () => new Response("x", { headers: { "content-type": "image/jpeg", "content-length": String(50 * 1024 * 1024) } }) }), v);
    expect(big.beats[0]).toMatchObject({ found: false, reason: "download refused (too_big)" });
    expect(await assetsForVideo(db.pool, v)).toEqual([]);
  });

  it("Build then plans a story_kenburns scene for the linked beat", async () => {
    const v = await seed();
    await run(mk(), v);
    const links = await assetsForVideo(db.pool, v);
    const ask = async () => JSON.stringify({ version: 1, scenes: [{ id: "s1", kind: "story_kenburns", beat: "b1", startMs: 0, durationMs: 3000, image: links[0]!.assetId, caption: "Engine" }] });
    const doc = await buildSceneDoc([{ id: "b1", text: "Engines burn petrol." }], ask as never, { pictures: { b1: links.map((l) => l.assetId) }, language: "en" });
    expect(doc.scenes[0]).toMatchObject({ kind: "story_kenburns", image: links[0]!.assetId });
  });
});
