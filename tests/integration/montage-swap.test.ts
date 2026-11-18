import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "@/server/core/content-hash";
import { systemRightsText } from "@/server/core/asset-rules";
import { uuidv7 } from "@/server/core/ids";
import { registerAsset } from "@/server/db/assets";
import { swapClipById } from "@/server/db/video-page-actions";
import { linkAsset } from "@/server/db/video-assets";
import { createVideoRow } from "@/server/db/videos";
import { withTestDb, type TestDb } from "../support/db";

// "Try another clip" on a Montage beat: the stage-made link is marked stale, the footage and edit steps get new nonces, and every
// refusal is a plain sentence that changes nothing.
let db: TestDb;
beforeAll(async () => { db = await withTestDb(); });
afterAll(async () => { await db?.stop(); });
beforeEach(async () => { await db.reset(); });

const actor = { kind: "session", sessionId: "0190f3a2-7c1e-7a55-9d3b-2f6c8a1b4e91" } as const;
const queue = { enqueue: async (id: string, fence: number, seq: number) => `stage.${id}.${fence}.${seq}` };

async function setup(kind = "montage", runs: Array<[string, string]> = [["pictures", "succeeded"], ["montage", "succeeded"]]) {
  const v = await createVideoRow(db.pool, { format: "short", kind: kind as never, language: "en", topic: "waves" });
  runs.forEach(([name, status], i) => db.pool.query("insert into stage_runs (id, video_id, name, status, input_hash) values ($1,$2,$3,$4,$5)", [uuidv7(), v.id, name, status, `h${i}`]));
  await new Promise((r) => setTimeout(r, 50));
  const c = await db.pool.connect();
  let assetId: string;
  try {
    assetId = (await registerAsset(c, {
      kind: "video", originalName: "x.mp4", mime: "video/mp4", bytes: 1000, width: 320, height: 180, durationS: 9, sha256: sha256Hex(uuidv7()), storageRef: `assets/${uuidv7()}/main.mp4`, derivedRefs: {},
      tags: ["stock"], caption: "waves", source: "stock", rights: { attestations: [{ at: new Date().toISOString(), by: "system", text: systemRightsText("Pixabay Content License", "Pixabay") }] }, containsPerson: false,
    })).asset.id;
  } finally { c.release(); }
  await linkAsset(db.pool, { videoId: v.id, assetId, beatId: "hook", credit: "Video by A on Pixabay", sourceUrl: null, licence: "Pixabay Content License", briefHash: "h" });
  return v.id;
}
const hash = async (id: string) => (await db.pool.query("select brief_hash from video_assets where video_id = $1", [id])).rows[0].brief_hash;
const nonces = async (id: string) => (await db.pool.query("select stage_nonces from videos where id = $1", [id])).rows[0].stage_nonces;

describe("swapClipById", () => {
  it("marks the beat's clip stale and gives the footage and edit steps new nonces", async () => {
    const id = await setup();
    const r = await swapClipById(db.pool, queue, actor, id, "hook");
    expect(r.ok).toBe(true);
    expect(await hash(id)).toBe("swap");
    const n = await nonces(id);
    expect(Object.keys(n).sort()).toEqual(["montage", "pictures"]);
  });
  it("refuses a video that is not a Montage, and changes nothing", async () => {
    const id = await setup("collage");
    const r = await swapClipById(db.pool, queue, actor, id, "hook");
    expect(r).toEqual({ ok: false, message: "Only a Montage video has footage clips to change." });
    expect(await hash(id)).toBe("h");
    expect(await nonces(id)).toEqual({});
  });
  it("refuses while a step is running, or before the edit has finished", async () => {
    const busy = await setup("montage", [["pictures", "succeeded"], ["montage", "running"]]);
    expect((await swapClipById(db.pool, queue, actor, busy, "hook")).message).toBe("Another step of this video is still running or waiting to run.");
    const early = await setup("montage", [["pictures", "succeeded"]]);
    expect((await swapClipById(db.pool, queue, actor, early, "hook")).message).toBe("The footage and edit steps must both be finished first.");
  });
  it("refuses a beat that has no clip the app picked", async () => {
    const id = await setup();
    expect((await swapClipById(db.pool, queue, actor, id, "nope")).message).toBe("That beat has no clip the app picked, so there is nothing to swap.");
    expect(await hash(id)).toBe("h");
  });
});
