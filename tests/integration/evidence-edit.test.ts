import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@/server/core/content-hash";
import { uuidv7 } from "@/server/core/ids";
import { UPLOAD_CAPS } from "@/server/core/publish-rules";
import { approveGate, liveGateHash } from "@/server/db/approvals";
import { defaultHead, loadEvidence, reseedEvidence, saveAndVerifyEvidence } from "@/server/db/evidence";
import { approvePublish } from "@/server/db/publish";
import { setSetting } from "@/server/db/settings";
import { addContent, createVideoRow, latestContent } from "@/server/db/videos";
import { createFakeUploader } from "@/server/providers/uploader/fake";
import type { UploadQueue } from "@/server/queue/job-queue";
import { handlePublishUpload } from "@/worker/stages/publish-upload";
import { metaBody } from "../support/publishable";
import { ensureChannel } from "../support/channel-fixture";
import { withTestDb, type TestDb } from "../support/db";

let db: TestDb;
let root: string;
beforeAll(async () => {
  db = await withTestDb();
});
beforeEach(async () => {
  await db.reset();
  root = mkdtempSync(path.join(tmpdir(), "evidence-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
afterAll(async () => {
  await db?.stop();
});

const SRC = { text: "Sky is blue", kind: "sourced", source_url: "https://example.com/sky", quote: "blue" };
const CALC = { text: "2 plus 2", kind: "computed", method: "addition" };
const queue = () => ({ enqueueUpload: vi.fn(async (id: string) => `upload.${id}`) }) as unknown as UploadQueue;
const count = async (sql: string) => Number((await db.pool.query(`select count(*) c from ${sql}`)).rows[0].c);

async function session(): Promise<{ kind: "session"; sessionId: string }> {
  const id = uuidv7();
  await db.pool.query(
    "insert into sessions (id, token_hash, expires_at, absolute_expires_at) values ($1, $2, clock_timestamp() + interval '1 hour', clock_timestamp() + interval '7 days')",
    [id, `t-${id}`],
  );
  return { kind: "session", sessionId: id };
}
/** A video with a real file, claim-based UNVERIFIED evidence (like Draft saves it) and a video approval. */
async function seed() {
  await ensureChannel(db.pool, "UC-test");
  const v = await createVideoRow(db.pool, { format: "short", kind: "scene_kit", language: "en", topic: "sky", channelId: "UC-test" });
  const bytes = Buffer.from(`video-${v.id}`);
  mkdirSync(path.join(root, "videos", v.id), { recursive: true });
  writeFileSync(path.join(root, "videos", v.id, "final.mp4"), bytes);
  await addContent(db.pool, v.id, "script", { body: { narration: "Light moves 300000 km a second.", title: "T", beats: [], evidence: [SRC] }, sha256: sha256Hex(`s-${v.id}`) });
  await addContent(db.pool, v.id, "video", { filePath: `videos/${v.id}/final.mp4`, sha256: sha256Hex(bytes) });
  await addContent(db.pool, v.id, "evidence", { body: { claims: [SRC] }, sha256: sha256Hex(`e-${v.id}`) });
  await addContent(db.pool, v.id, "metadata", { body: metaBody(), sha256: sha256Hex("m") });
  const actor = await session();
  await approveGate(db.pool, { videoId: v.id, gate: "video", seenHash: (await liveGateHash(db.pool, v.id, "video"))!.hash, actor });
  return { id: v.id, actor };
}
const signOff = async (id: string, actor: { kind: "session"; sessionId: string }) => approveGate(db.pool, { videoId: id, gate: "evidence", seenHash: (await liveGateHash(db.pool, id, "evidence"))!.hash, actor });
const publish = async (id: string, actor: { kind: "session"; sessionId: string }, q = queue()) =>
  approvePublish(db.pool, q, { videoId: id, seenHash: (await liveGateHash(db.pool, id, "publish"))!.hash, visibility: "private", publishAt: null, channelId: "UC-test", actor }, { root });

describe("owner session only", () => {
  it("an agent, a token or no actor cannot save, verify or re-seed evidence", async () => {
    const { id } = await seed();
    const head = vi.fn(async () => 200);
    const before = (await latestContent(db.pool, id, "evidence"))!.version;
    for (const actor of [{ kind: "agent", sessionId: uuidv7() }, { kind: "token", sessionId: uuidv7() }, { kind: "session" }, null, undefined]) {
      expect((await saveAndVerifyEvidence(db.pool, id, [SRC], actor as never, head)).ok).toBe(false);
      expect((await reseedEvidence(db.pool, id, actor as never)).ok).toBe(false);
    }
    expect(head).not.toHaveBeenCalled();
    expect((await latestContent(db.pool, id, "evidence"))!.version).toBe(before);
    expect(await count("audit_log where event like 'evidence.%'")).toBe(0);
  });
});

describe("save and verify", () => {
  it("checks each source once, stores the result, and an edit afterwards un-verifies", async () => {
    const { id, actor } = await seed();
    const head = vi.fn(async () => 200);
    const r = await saveAndVerifyEvidence(db.pool, id, [SRC, SRC, CALC], actor, head);
    expect(r).toMatchObject({ ok: true, verified: true });
    expect(head).toHaveBeenCalledTimes(1);
    expect((await loadEvidence(db.pool, id)).verifiedNow).toBe(true);
    const body = (await latestContent(db.pool, id, "evidence"))!.body as { verification: { claims_sha: string; by: string } };
    expect(body.verification).toMatchObject({ by: "owner", claims_sha: expect.stringMatching(/^[0-9a-f]{64}$/) });
    // an edit that is saved without a check (a re-seed) leaves nothing verified
    await reseedEvidence(db.pool, id, actor);
    expect((await loadEvidence(db.pool, id)).verifiedNow).toBe(false);
  });

  it("saves a failed check with its reasons and does not retry", async () => {
    const { id, actor } = await seed();
    const head = vi.fn(async () => 404);
    const r = await saveAndVerifyEvidence(db.pool, id, [SRC], actor, head);
    expect(r).toMatchObject({ ok: true, verified: false });
    expect(head).toHaveBeenCalledTimes(1);
    const ev = await loadEvidence(db.pool, id);
    expect(ev.verifiedNow).toBe(false);
    expect(ev.verification?.problems[0]).toMatch(/404/);
  });

  it("a site that rejects HEAD with 405 still counts as reachable; a thrown error is a failure", async () => {
    const { id, actor } = await seed();
    expect(await saveAndVerifyEvidence(db.pool, id, [SRC], actor, async () => 405)).toMatchObject({ verified: true });
    expect(await saveAndVerifyEvidence(db.pool, id, [SRC], actor, async () => { throw new Error("The operation was aborted due to timeout"); })).toMatchObject({ verified: false });
  });

  it("refuses more than 10 different sources without calling anyone, and bad claims without saving", async () => {
    const { id, actor } = await seed();
    const many = Array.from({ length: 11 }, (_, i) => ({ ...SRC, source_url: `https://example.com/${i}` }));
    const head = vi.fn(async () => 200);
    expect(await saveAndVerifyEvidence(db.pool, id, many, actor, head)).toMatchObject({ ok: true, verified: false });
    expect(head).not.toHaveBeenCalled();
    const v = (await latestContent(db.pool, id, "evidence"))!.version;
    expect((await saveAndVerifyEvidence(db.pool, id, [{ ...SRC, source_url: "file:///etc/passwd" }], actor, head)).ok).toBe(false);
    expect((await latestContent(db.pool, id, "evidence"))!.version).toBe(v);
  });

  it("the real HEAD check refuses local and private addresses (safeFetch)", async () => {
    await expect(defaultHead("http://127.0.0.1:9/x")).rejects.toThrow();
    await expect(defaultHead("http://169.254.169.254/latest")).rejects.toThrow();
    const { id, actor } = await seed();
    const r = await saveAndVerifyEvidence(db.pool, id, [{ ...SRC, source_url: "http://10.0.0.1/secret" }], actor, defaultHead);
    expect(r).toMatchObject({ ok: true, verified: false });
  });

  it("re-seed replaces the claims with the script's and they are not verified", async () => {
    const { id, actor } = await seed();
    await saveAndVerifyEvidence(db.pool, id, [CALC], actor, async () => 200);
    expect(await reseedEvidence(db.pool, id, actor)).toEqual({ ok: true, count: 1 });
    const ev = await loadEvidence(db.pool, id);
    expect(ev.claims).toHaveLength(1);
    expect(ev.verifiedNow).toBe(false);
  });
});

describe("require_evidence at publish approval (fake uploader)", () => {
  it("is refused until the evidence is verified, then approved and uploaded once", async () => {
    const { id, actor } = await seed();
    await signOff(id, actor); // signed off but never verified
    const q = queue();
    expect(await publish(id, actor, q)).toMatchObject({ ok: false, reason: expect.stringMatching(/verified/i) });
    expect(await count("uploads")).toBe(0);

    await saveAndVerifyEvidence(db.pool, id, [SRC], actor, async () => 200); // new evidence version: the sign-off no longer counts
    expect(await publish(id, actor, q)).toMatchObject({ ok: false, reason: expect.stringMatching(/evidence/i) });
    await signOff(id, actor);
    const ok = await publish(id, actor, q);
    expect(ok).toMatchObject({ ok: true });

    const up = createFakeUploader();
    const res = await handlePublishUpload(db.pool, { uploader: up, root, caps: { ...UPLOAD_CAPS } }, (ok as { uploadId: string }).uploadId);
    expect(res).toMatchObject({ started: true });
    expect(up.totalCalls()).toBeGreaterThan(0);
  });

  it("a failed verification still blocks", async () => {
    const { id, actor } = await seed();
    await saveAndVerifyEvidence(db.pool, id, [SRC], actor, async () => 500);
    await signOff(id, actor);
    expect(await publish(id, actor)).toMatchObject({ ok: false, reason: expect.stringMatching(/verified/i) });
  });

  it("file-only evidence (no claims) is refused while require_evidence is on, and allowed when it is off", async () => {
    const { id, actor } = await seed();
    await addContent(db.pool, id, "evidence", { filePath: "e/1.pdf", sha256: sha256Hex("file-evidence") });
    await signOff(id, actor);
    expect(await publish(id, actor)).toMatchObject({ ok: false, reason: expect.stringMatching(/verified/i) });
    await setSetting(db.pool, "policy.require_evidence", false, { actor: "session" });
    expect((await publish(id, actor)).ok).toBe(true);
  });

  it("legacy metadata with only a title is refused at approval until the details are saved", async () => {
    const { id, actor } = await seed();
    await addContent(db.pool, id, "metadata", { body: { title: "t", visibility: "private", publish_at: null }, sha256: sha256Hex("legacy") });
    await saveAndVerifyEvidence(db.pool, id, [SRC], actor, async () => 200);
    await signOff(id, actor);
    expect(await publish(id, actor)).toMatchObject({ ok: false, reason: expect.stringMatching(/save the upload details/i) });
    expect(await count("uploads")).toBe(0);
  });

  it("with require_evidence off, unverified evidence does not block", async () => {
    const { id, actor } = await seed();
    await setSetting(db.pool, "policy.require_evidence", false, { actor: "session" });
    expect((await publish(id, actor)).ok).toBe(true);
  });
});
