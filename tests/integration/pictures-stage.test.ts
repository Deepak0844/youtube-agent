import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RIGHTS_TEXT } from "@/server/core/asset-rules";
import { registerAsset } from "@/server/db/assets";
import { buildEngineConfig } from "@/server/core/engine-config";
import { canonicalJson, sha256Hex } from "@/server/core/content-hash";
import { uuidv7 } from "@/server/core/ids";
import { buildSceneDoc } from "@/server/core/scene-build";
import { createStageContext } from "@/server/core/stage-handler";
import { approveGate, liveGateHash } from "@/server/db/approvals";
import { createPgPaidCallPorts } from "@/server/db/paid-call-adapter";
import { claimStage, insertQueuedStage } from "@/server/db/stages";
import { assetsForVideo, creditsForVideo, linkAsset, unlinkAll } from "@/server/db/video-assets";
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

async function seed(beats: unknown[] = BEATS, existing?: string, kind: "collage" | "ai" = "collage"): Promise<string> {
  const v = existing ? { id: existing } : await createVideoRow(db.pool, { format: "short", kind, language: "en", topic: "engines" });
  const d = fakeDraft("en") as { title: string; narration: string };
  const body = { title: d.title, narration: d.narration + (existing ? ` v${Math.random()}` : "") };
  await addContent(db.pool, v.id, "script", { body, sha256: sha256Hex(canonicalJson(body)) });
  const b = { beats };
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
function mk(over: { api?: (q: string) => Response; file?: () => Response; throws?: boolean; sha?: string; pixabay?: () => Response; onFile?: () => void; deadline?: AbortSignal } = {}): Fake {
  const urls: string[] = [];
  const api = over.api ?? ((q) => (q.includes("petrol") ? json([page("Petrol engine cutaway", "CC BY 4.0")]) : json([])));
  const deps: PicturesDeps = {
    db: db.pool, root,
    fetcher: async (url) => {
      urls.push(url);
      if (over.throws) throw new Error("offline");
      const u = new URL(url);
      if (u.hostname === "commons.wikimedia.org") return api(u.searchParams.get("gsrsearch") ?? "");
      if (u.hostname === "pixabay.com" && u.pathname.startsWith("/api/")) return over.pixabay ? over.pixabay() : json([]);
      over.onFile?.();
      return over.file ? over.file() : new Response(new Uint8Array([1, 2, 3, 4]), { headers: { "content-type": "image/jpeg" } });
    },
    ingest: { runChild: async () => { throw new Error("not used"); } },
    ingestImageFn: async (_d, a) => ({
      ok: true, kind: "image", mime: "image/jpeg", width: 1280, height: 853, durationS: null, bytes: 4, originalBytes: 4,
      sha256: createHash("sha256").update(over.sha ?? "same-bytes").digest("hex"), files: { main: path.join(a.destDir, "main.jpg") },
    }),
    sleep: async () => undefined,
    ...(over.deadline ? { deadline: over.deadline } : {}),
    ...(over.pixabay ? { pixabayKey: async () => "k" } : {}),
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

  it("does not bring a trashed library asset back, and does not link it", async () => {
    const v = await seed();
    await run(mk(), v);
    await db.pool.query("update assets set deleted_at = now()");
    await unlinkAll(db.pool, v);
    const out = await run(mk(), v);
    expect(out.linked).toBe(0);
    expect(out.beats[0]).toMatchObject({ found: false, reason: "picture was deleted from the library" });
    expect((await db.pool.query("select deleted_at from assets")).rows[0].deleted_at).not.toBeNull();
    expect(await assetsForVideo(db.pool, v)).toEqual([]);
  });

  it("re-picks when the beat brief changed under the same beat id, and drops links of beats that left the script", async () => {
    const v = await seed();
    await run(mk({ sha: "first" }), v);
    const first = (await assetsForVideo(db.pool, v))[0]!;
    // same replay: skipped
    expect((await run(mk({ sha: "second" }), v)).beats[0]).toMatchObject({ reason: "already linked" });
    await seed([{ ...BEATS[0], visual: "cutaway diagram of a petrol motor", search: ["petrol engine cutaway"] }, BEATS[1]], v);
    const out = await run(mk({ sha: "second" }), v);
    expect(out.linked).toBe(1);
    const links = await assetsForVideo(db.pool, v);
    expect(links).toHaveLength(1);
    expect(links[0]!.assetId).not.toBe(first.assetId);
    await seed([BEATS[1]!], v); // b1 is gone from the script
    await run(mk(), v);
    expect(await assetsForVideo(db.pool, v)).toEqual([]);
  });

  it("never touches a picture the owner linked by hand", async () => {
    const v = await seed();
    const a = (await registerAsset(db.pool, { kind: "image", originalName: "m.png", mime: "image/png", bytes: 10, sha256: "e".repeat(64), storageRef: "assets/m/main.png", rights: { attestations: [{ at: new Date().toISOString(), text: RIGHTS_TEXT }] } })).asset.id;
    await linkAsset(db.pool, { videoId: v, assetId: a, beatId: "b1" });
    const out = await run(mk(), v);
    expect(out.beats[0]).toMatchObject({ beatId: "b1", reason: "already linked" });
    expect((await assetsForVideo(db.pool, v)).map((l) => l.assetId)).toEqual([a]);
  });

  it("drops candidates with malformed or off-list addresses from the answer and still succeeds", async () => {
    const v = await seed();
    const bad = page("Petrol engine cutaway", "CC0");
    (bad.imageinfo[0] as { url: string; thumburl: string }).url = "https://evil.example/x.jpg";
    (bad.imageinfo[0] as { url: string; thumburl: string }).thumburl = "not a url";
    const f = mk({ api: () => json([bad]) });
    const out = await run(f, v);
    expect(out.linked).toBe(0);
    expect(f.urls.some((u) => u.includes("evil"))).toBe(false);
  });

  it("refuses a person-tagged Pixabay hit and takes a clean one", async () => {
    const hit = (tags: string) => () => new Response(JSON.stringify({ hits: [{ id: 1, largeImageURL: "https://pixabay.com/get/x_1280.jpg", pageURL: "https://pixabay.com/photos/x-1/", imageWidth: 4000, imageHeight: 3000, tags, user: "bob" }] }), { headers: { "content-type": "application/json" } });
    const v = await seed();
    expect((await run(mk({ api: () => json([]), pixabay: hit("petrol, engine, cutaway, man") }), v)).linked).toBe(0);
    const ok = await run(mk({ api: () => json([]), pixabay: hit("petrol, engine, cutaway, metal") }), v);
    expect(ok.linked).toBe(1);
    expect(ok.beats[0]).toMatchObject({ source: "pixabay", licence: "Pixabay Content License" });
  });

  it("stores a system-checked licence record, not an owner statement", async () => {
    const v = await seed();
    await run(mk(), v);
    const att = (await db.pool.query("select rights from assets")).rows[0].rights.attestations[0];
    expect(att).toMatchObject({ by: "system", text: "Free licence (CC BY 4.0) checked automatically from Wikimedia Commons" });
  });

  it("returns what it has when the time budget runs out (rest get 'deadline')", async () => {
    const v = await seed([BEATS[0], { id: "b2", text: "y", visual: "petrol engine cutaway diagram", search: ["petrol engine cutaway"] }]);
    const ac = new AbortController();
    const out = await run(mk({ deadline: ac.signal, onFile: () => ac.abort(new Error("time")) }), v);
    expect(out.beats).toMatchObject([{ beatId: "b1", found: true }, { beatId: "b2", found: false, reason: "deadline" }]);
    expect(await assetsForVideo(db.pool, v)).toHaveLength(1);
  });

describe("pictures stage for a collage video", () => {
  const collageSeed = async () => {
    const id = await seed();
    await db.pool.query("update videos set kind = 'collage' where id = $1", [id]);
    return id;
  };
  it("links the cut-out instead of the plain picture (the credit stays), and skips clips", async () => {
    const v = await collageSeed();
    const f = mk();
    const made: string[] = [];
    // a stand-in for the background remover: registers a second, see-through asset and returns its id
    f.deps.cutout = async (assetId) => {
      const r = await db.pool.query<{ id: string }>(
        "insert into assets (kind, original_name, mime, bytes, width, height, sha256, storage_ref, tags, source, rights) select kind, 'cutout-x.png', 'image/png', 9, width, height, $2, storage_ref, array['cutout'], 'generated', rights from assets where id = $1 returning id",
        [assetId, createHash("sha256").update("cut-" + assetId).digest("hex")],
      );
      made.push(r.rows[0]!.id);
      return r.rows[0]!.id;
    };
    const out = await run(f, v);
    expect(out.linked).toBe(1);
    const links = await assetsForVideo(db.pool, v);
    expect(links.map((l) => l.assetId)).toEqual(made);
    expect(links[0]).toMatchObject({ cutout: true, credit: expect.stringContaining("Jane Doe") });
    expect(f.urls.some((u) => u.includes("pixabay.com/api/videos"))).toBe(false);
  });
  it("keeps the plain picture when the cut-out cannot be made, and never fails the stage", async () => {
    const v = await collageSeed();
    const f = mk();
    f.deps.cutout = async () => { throw new Error("model crashed"); };
    const out = await run(f, v);
    expect(out.linked).toBe(1);
    const links = await assetsForVideo(db.pool, v);
    expect(links).toHaveLength(1);
    expect(links[0]!.cutout).toBeUndefined();
    const f2 = mk({ sha: "other" });
    const v2 = await collageSeed();
    f2.deps.cutout = async () => null;
    expect((await run(f2, v2)).linked).toBe(1);
  });
  it("other kinds never call the cut-out step", async () => {
    const v = await seed(BEATS, undefined, "ai");
    const f = mk();
    let called = 0;
    f.deps.cutout = async () => (called++, null);
    await run(f, v);
    expect(called).toBe(0);
  });
});
});
