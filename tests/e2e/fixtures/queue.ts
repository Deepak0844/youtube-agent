import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { hashToken } from "@/server/core/auth-crypto";
import { sha256Hex } from "@/server/core/content-hash";
import { uuidv7 } from "@/server/core/ids";
import { versionsKey } from "@/server/core/queue-input";
import { approvalReaders } from "@/server/db/approval-readers";
import { approveGate, liveGateHash } from "@/server/db/approvals";
import { advanceVideo } from "@/server/db/pipeline";
import { claimStage, commitStage } from "@/server/db/stages";
import { addContent, createVideoRow } from "@/server/db/videos";
import { mintSession } from "./sessions";

// Test-only seeding for the queue specs. Everything goes through the app role in the e2e database, the same role the real
// server and worker use. There is no worker in the e2e run, so a "worker" step is played here by claiming and committing the
// queued stage row by hand.
let pool: pg.Pool | undefined;
export const db = (): pg.Pool => (pool ??= new pg.Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 3 }));
export async function endQueuePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

/** Collects the stage ids the real code tries to enqueue (nothing consumes them). */
export const nullQueue = { enqueue: async (id: string, fence: number, seq: number) => `stage.${id}.${fence}.${seq}` };

export const script = (title: string) => ({
  title,
  description: "A short explainer",
  narration: "The sky looks blue because air scatters blue light more than red light, so blue reaches your eyes from every direction.",
  beats: [{ id: "hook", text: "hook" }, { id: "why", text: "why" }],
  evidence: [{ text: "Air scatters blue light", kind: "sourced", source_url: "https://example.test/rayleigh", quote: "scatters blue light" }],
});
export const costPlan = { providers_models: { llm: "claude-test" }, path: "scene_kit", library_scene_versions: { intro: 1 }, quote: { micro_usd: "2500000" }, items: [{ kind: "image", provider: "fakeimg", quoteMicroUsd: 2_500_000 }] };

/** Runs the queued stage row of a video the way a worker would: claim it, commit it. Returns false when none is queued. */
export async function workerFinishes(videoId: string, stage: string): Promise<boolean> {
  const { rows } = await db().query<{ id: string; input_hash: string }>("select id, input_hash from stage_runs where video_id = $1 and name = $2 and status = 'queued' order by created_at desc limit 1", [videoId, stage]);
  if (!rows[0]) return false;
  const c = await claimStage(db(), { id: rows[0].id, inputHash: rows[0].input_hash, workerId: "e2e-worker", ttlMs: 60_000 });
  if (!c) return false;
  await commitStage(db(), c, {});
  return true;
}

export async function advance(videoId: string): Promise<void> {
  await advanceVideo(db(), nullQueue, videoId, approvalReaders);
}

/** A video whose draft finished: the pipeline waits at the script gate. `withCost` adds a paid cost plan so the cost gate follows. */
export async function seedScriptGate(topic: string, opts: { withCost?: boolean } = {}): Promise<{ videoId: string }> {
  const v = await createVideoRow(db(), { format: "short", kind: "scene_kit", language: "en", topic, channelId: "UC-e2e" });
  await addContent(db(), v.id, "script", { body: script(topic), sha256: sha256Hex(`script-${v.id}`) });
  if (opts.withCost) await addContent(db(), v.id, "cost_plan", { body: costPlan, sha256: sha256Hex(`plan-${v.id}`) });
  await advance(v.id);
  await workerFinishes(v.id, "draft");
  await advance(v.id);
  return { videoId: v.id };
}

/** The draft stage ran, an unclear paid call is open: the stage is parked with a $0.25 reservation. */
export async function seedParked(topic: string): Promise<{ videoId: string; stageId: string }> {
  const v = await createVideoRow(db(), { format: "short", kind: "scene_kit", language: "en", topic });
  const stageId = uuidv7();
  await db().query("insert into stage_runs (id, video_id, name, status, input_hash) values ($1, $2, 'draft', 'needs_decision', $3)", [stageId, v.id, sha256Hex(`parked-${stageId}`)]);
  await db().query(
    "insert into spend_intents (id, stage_run_id, step_index, tool_call_index, call_key, status, reserved_micro_usd, scopes) values ($1, $2, 0, 0, $3, 'unknown', 250000, '{}')",
    [uuidv7(), stageId, `e2e-${stageId}`],
  );
  return { videoId: v.id, stageId };
}

export async function liveFields(videoId: string, gate: "script" | "cost" | "video" | "evidence" | "publish") {
  const live = (await liveGateHash(db(), videoId, gate))!;
  return { videoId, gate, seenHash: live.hash, seenVersions: versionsKey(live.versions) };
}

/** A video at the publish gate: real file under the e2e storage root, video and evidence signed off by a real session. */
export async function seedPublishGate(topic: string, visibility: "private" | "unlisted" | "public" = "private"): Promise<{ videoId: string }> {
  const root = process.env.E2E_STORAGE_ROOT!;
  const v = await createVideoRow(db(), { format: "short", kind: "scene_kit", language: "en", topic, channelId: "UC-e2e" });
  const rel = `queue-e2e/${v.id}.mp4`;
  mkdirSync(path.join(root, "queue-e2e"), { recursive: true });
  const bytes = Buffer.from(`video-bytes-${v.id}`);
  writeFileSync(path.join(root, rel), bytes);
  await addContent(db(), v.id, "script", { body: script(topic), sha256: sha256Hex(`script-${v.id}`) });
  await addContent(db(), v.id, "video", { filePath: rel, sha256: sha256Hex(bytes) });
  await addContent(db(), v.id, "evidence", { filePath: `queue-e2e/${v.id}.pdf`, sha256: sha256Hex(`evidence-${v.id}`) });
  await addContent(db(), v.id, "metadata", { body: { title: topic, description: "Watch this", visibility, publish_at: null }, sha256: sha256Hex(`meta-${v.id}`) });
  const token = await mintSession();
  const s = await db().query<{ id: string }>("select id from sessions where token_hash = $1", [hashToken(token)]);
  const actor = { kind: "session", sessionId: s.rows[0]!.id } as const;
  for (const g of ["video", "evidence"] as const) {
    const r = await approveGate(db(), { videoId: v.id, gate: g, seenHash: (await liveGateHash(db(), v.id, g))!.hash, actor });
    if (!r.ok) throw new Error(`seed ${g}: ${r.reason}`);
  }
  // Every earlier stage is done; the pipeline now waits at the publish gate.
  for (const stage of ["draft", "build", "tts", "render", "voice", "sfx", "qa"]) {
    await advance(v.id);
    await workerFinishes(v.id, stage);
    if (stage === "draft") {
      const sc = await liveGateHash(db(), v.id, "script");
      await approveGate(db(), { videoId: v.id, gate: "script", seenHash: sc!.hash, actor });
    }
  }
  await advance(v.id);
  return { videoId: v.id };
}
