import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type pg from "pg";
import { sha256Hex } from "@/server/core/content-hash";
import type { GateId } from "@/server/core/gates";
import { approveGate, liveGateHash } from "@/server/db/approvals";
import { approvePublish } from "@/server/db/publish";
import { addContent, createVideoRow, type ContentKind } from "@/server/db/videos";
import type { GateAct, GateAttempt, GateResult } from "./gate-invariants";

// Real-database fixture shared by the per-gate suites in tests/integration/gates/. One fresh video per call.
const meta = { visibility: "private", publish_at: null };
const plan = { providers_models: { llm: "m1" }, path: "scene_kit", library_scene_versions: { a: 1 }, quote: { micro_usd: "5" } };

export async function seedVideo(db: pg.Pool): Promise<string> {
  const v = await createVideoRow(db, { format: "short", kind: "scene_kit", language: "en", topic: "topic", channelId: "UC1" });
  await addContent(db, v.id, "script", { body: { text: "v1" }, sha256: sha256Hex("script-1") });
  await addContent(db, v.id, "cost_plan", { body: plan, sha256: sha256Hex("plan-1") });
  await addContent(db, v.id, "video", { filePath: "v/1.mp4", sha256: sha256Hex("video-1") });
  await addContent(db, v.id, "evidence", { filePath: "e/1.pdf", sha256: sha256Hex("evidence-1") });
  await addContent(db, v.id, "metadata", { body: meta, sha256: sha256Hex("meta-1") });
  return v.id;
}

/** A new version of a kind the gate covers (the hash must change). */
export async function bumpContent(db: pg.Pool, videoId: string, kind: ContentKind): Promise<void> {
  const body = kind === "cost_plan" ? plan : kind === "metadata" ? meta : { text: "changed" };
  const n = Math.random().toString(36);
  if (kind === "video" || kind === "evidence") await addContent(db, videoId, kind, { filePath: `f/${n}`, sha256: sha256Hex(`${kind}-${n}`) });
  else await addContent(db, videoId, kind, { body, sha256: sha256Hex(`${kind}-${n}`) });
}

export const SESSION_ID = "11111111-1111-4111-8111-111111111111";
export const STALE = "0".repeat(64);

/** Builds the `act` function the harness needs: drives the real approveGate. Non-session actors are passed through untyped. */
export async function gateFixture(db: pg.Pool, gate: GateId): Promise<{ videoId: string; seen: string; act: GateAct; resultOf: (r: Awaited<ReturnType<typeof approveGate>>) => GateResult }> {
  const videoId = await seedVideo(db);
  if (gate === "publish") return publishFixture(db, videoId);
  const seen = (await liveGateHash(db, videoId, gate))?.hash;
  if (!seen) throw new Error("fixture: no live hash");
  const act = async ({ actor, hash }: GateAttempt): Promise<GateResult> => {
    const seenHash = hash === "seen" ? seen : hash === "current" ? ((await liveGateHash(db, videoId, gate))?.hash ?? STALE) : STALE;
    const r = await approveGate(db, { videoId, gate, seenHash, actor: { kind: actor, sessionId: SESSION_ID } as never });
    return r.ok ? { ok: true } : { ok: false, reason: r.reason };
  };
  return { videoId, seen, act, resultOf: (r) => (r.ok ? { ok: true } : { ok: false, reason: r.reason }) };
}

/**
 * The publish gate has ONE legal path, approvePublish: it needs a real session, the video file on disk (the seed's
 * "v/1.mp4" holds the text "video-1", whose sha256 the seed stored) and the video and evidence gates signed off.
 */
async function publishFixture(db: pg.Pool, videoId: string): Promise<{ videoId: string; seen: string; act: GateAct; resultOf: (r: Awaited<ReturnType<typeof approveGate>>) => GateResult }> {
  const root = mkdtempSync(path.join(tmpdir(), "gate-publish-"));
  mkdirSync(path.join(root, "v"), { recursive: true });
  writeFileSync(path.join(root, "v/1.mp4"), "video-1");
  await db.query(
    "insert into sessions (id, token_hash, expires_at, absolute_expires_at) values ($1, 'gate-fixture', clock_timestamp() + interval '1 day', clock_timestamp() + interval '7 days') on conflict (id) do nothing",
    [SESSION_ID],
  );
  const actor = { kind: "session", sessionId: SESSION_ID } as const;
  for (const g of ["video", "evidence"] as const) await approveGate(db, { videoId, gate: g, seenHash: (await liveGateHash(db, videoId, g))!.hash, actor });
  const seen = (await liveGateHash(db, videoId, "publish"))?.hash;
  if (!seen) throw new Error("fixture: no live hash");
  const queue = { enqueueUpload: async (id: string) => `upload.${id}` };
  const act = async ({ actor: kind, hash }: GateAttempt): Promise<GateResult> => {
    const seenHash = hash === "seen" ? seen : hash === "current" ? ((await liveGateHash(db, videoId, "publish"))?.hash ?? STALE) : STALE;
    const r = await approvePublish(db, queue, { videoId, seenHash, visibility: "private", publishAt: null, channelId: "UC1", actor: { kind, sessionId: SESSION_ID } as never }, { root });
    return r.ok ? { ok: true } : { ok: false, reason: r.reason };
  };
  return { videoId, seen, act, resultOf: (r) => (r.ok ? { ok: true } : { ok: false, reason: r.reason }) };
}
