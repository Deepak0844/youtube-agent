import type pg from "pg";
import { canonicalJson, sha256Hex } from "@/server/core/content-hash";
import type { GateId } from "@/server/core/gates";
import { uuidv7 } from "@/server/core/ids";
import {
  STAGE_NAMES,
  ACTIVE_STATUSES,
  expectedInputHash,
  nextActions,
  stagePlan,
  type Action,
  type ContentKindName,
  type PipelineView,
  type RunStatus,
  type StageName,
} from "@/server/core/pipeline-plan";
import type { StageQueue } from "@/server/queue/job-queue";
import { getSetting } from "@/server/db/settings";
import { cancelQueuedStage, requestCancel } from "@/server/db/stages";
import { createVideoRow, type VideoInput, type VideoRow } from "@/server/db/videos";

// Moves a video along its route exactly once. One transaction decides and inserts the stage_runs row (the video row is
// locked, and a partial unique index is the backstop); the queue add happens strictly AFTER commit. A crash between
// the two leaves a queued row the reconciler enqueues; a crash before the next row exists is caught by advanceAll.

export type EnqueueOnly = Pick<StageQueue, "enqueue">;

/** Where the pipeline learns about owner decisions. Approvals (hash-bound, Task 04) plug in here; until they exist the
 *  defaults say "nothing approved, no feedback", so a video stops at its first gate. */
export interface PipelineReaders {
  approvedGates(db: pg.PoolClient, videoId: string): Promise<ReadonlySet<GateId>>;
  feedback(db: pg.PoolClient, videoId: string): Promise<string | null>;
}
export const NO_DECISIONS: PipelineReaders = {
  approvedGates: async () => new Set<GateId>(),
  feedback: async () => null,
};

export const createVideo = (db: pg.Pool, input: VideoInput): Promise<VideoRow> => createVideoRow(db, input);

export interface AdvanceResult {
  /** stage_runs ids created and handed to the queue */
  enqueued: string[];
  /** stage_runs ids created but whose queue add failed; they stay queued and the reconciler delivers them */
  enqueueFailed: string[];
  action: Action | null;
}

interface VideoLocked {
  id: string;
  format: "short" | "long";
  kind: PipelineView["kind"];
  language: string;
  topic: string;
  notes: string | null;
  status: string;
}

async function lockVideo(c: pg.PoolClient, videoId: string): Promise<VideoLocked> {
  const r = await c.query<VideoLocked>("select id, format, kind, language, topic, notes, status from videos where id = $1 for update", [videoId]);
  const v = r.rows[0];
  if (!v) throw new Error(`video not found: ${videoId}`);
  return v;
}

async function buildView(c: pg.PoolClient, v: VideoLocked, readers: PipelineReaders): Promise<PipelineView> {
  const content = await c.query<{ kind: ContentKindName; sha256: string; body: unknown }>(
    "select distinct on (kind) kind, sha256, body from video_content where video_id = $1 order by kind, version desc",
    [v.id],
  );
  const shas: PipelineView["content"] = {};
  let paid = false;
  for (const row of content.rows) {
    shas[row.kind] = row.sha256;
    if (row.kind === "cost_plan") {
      const items = (row.body as { items?: unknown } | null)?.items;
      paid = Array.isArray(items) && items.length > 0;
    }
  }
  const runsQ = await c.query<{ name: string; status: RunStatus; input_hash: string }>(
    "select distinct on (name) name, status, input_hash from stage_runs where video_id = $1 order by name, created_at desc, id desc",
    [v.id],
  );
  const runs: PipelineView["runs"] = {};
  for (const r of runsQ.rows) if ((STAGE_NAMES as readonly string[]).includes(r.name)) runs[r.name as StageName] = { status: r.status, inputHash: r.input_hash };
  const requireEvidence = (await getSetting(c, "policy.require_evidence")) === true;
  return {
    kind: v.kind,
    format: v.format,
    flags: { requireEvidence, paidGeneration: paid },
    paramsHash: sha256Hex(canonicalJson({ format: v.format, kind: v.kind, language: v.language, topic: v.topic, notes: v.notes })),
    feedback: await readers.feedback(c, v.id),
    content: shas,
    runs,
    approved: await readers.approvedGates(c, v.id),
  };
}

async function insertRun(c: pg.PoolClient, videoId: string, stage: StageName, inputHash: string): Promise<string | null> {
  const id = uuidv7();
  const r = await c.query(
    "insert into stage_runs (id, video_id, name, status, input_hash) values ($1,$2,$3,'queued',$4) on conflict do nothing",
    [id, videoId, stage, inputHash],
  );
  return r.rowCount === 1 ? id : null;
}

async function deliver(queue: EnqueueOnly, created: Array<{ id: string; inputHash: string }>): Promise<Pick<AdvanceResult, "enqueued" | "enqueueFailed">> {
  const out = { enqueued: [] as string[], enqueueFailed: [] as string[] };
  for (const s of created) {
    try {
      await queue.enqueue(s.id, 0, 0, s.inputHash);
      out.enqueued.push(s.id);
    } catch {
      out.enqueueFailed.push(s.id);
    }
  }
  return out;
}

async function inTx<T>(db: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect();
  try {
    await c.query("begin");
    try {
      const out = await fn(c);
      await c.query("commit");
      return out;
    } catch (e) {
      await c.query("rollback").catch(() => undefined);
      throw e;
    }
  } finally {
    c.release();
  }
}

const LIVE_VIDEO = ["active", "waiting"];

export async function advanceVideo(db: pg.Pool, queue: EnqueueOnly, videoId: string, readers: PipelineReaders = NO_DECISIONS): Promise<AdvanceResult> {
  const decided = await inTx(db, async (c) => {
    const v = await lockVideo(c, videoId);
    if (!LIVE_VIDEO.includes(v.status)) return { created: [], action: null as Action | null };
    const view = await buildView(c, v, readers);
    const [action] = nextActions(view);
    const created: Array<{ id: string; inputHash: string }> = [];
    if (action?.kind === "enqueue") {
      const id = await insertRun(c, videoId, action.stage, action.inputHash);
      if (id) created.push({ id, inputHash: action.inputHash });
    }
    const next = action?.kind === "wait_gate" || action?.kind === "done" ? "waiting" : "active";
    if (next !== v.status) await c.query("update videos set status = $2, updated_at = now() where id = $1", [videoId, next]);
    return { created, action: action ?? null };
  });
  return { ...(await deliver(queue, decided.created)), action: decided.action };
}

export interface SweepResult {
  videos: number;
  enqueued: string[];
  enqueueFailed: string[];
  errors: Array<{ videoId: string; error: string }>;
}

/** Sweep: advance every live video. Catches a video stranded between "stage committed" and "next stage created". */
export async function advanceAll(db: pg.Pool, queue: EnqueueOnly, readers: PipelineReaders = NO_DECISIONS, opts: { limit?: number } = {}): Promise<SweepResult> {
  const { rows } = await db.query<{ id: string }>("select id from videos where status = any($1::text[]) order by updated_at, id limit $2", [LIVE_VIDEO, opts.limit ?? 500]);
  const out: SweepResult = { videos: rows.length, enqueued: [], enqueueFailed: [], errors: [] };
  for (const { id } of rows) {
    try {
      const r = await advanceVideo(db, queue, id, readers);
      out.enqueued.push(...r.enqueued);
      out.enqueueFailed.push(...r.enqueueFailed);
    } catch (e) {
      out.errors.push({ videoId: id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

/** Explicit rerun of one stage (failed, cancelled or stale). Refuses while a run is active or when nothing changed. */
export async function rerunStage(db: pg.Pool, queue: EnqueueOnly, videoId: string, stage: StageName, readers: PipelineReaders = NO_DECISIONS): Promise<AdvanceResult> {
  const created = await inTx(db, async (c) => {
    const v = await lockVideo(c, videoId);
    if (!LIVE_VIDEO.includes(v.status)) throw new Error(`video is ${v.status}`);
    const view = await buildView(c, v, readers);
    const plan = stagePlan(view.kind, view.format, view.flags);
    const idx = plan.findIndex((s) => s.stage === stage);
    if (idx < 0) throw new Error(`stage ${stage} is not on this video's route`);
    const run = view.runs[stage];
    if (run && ACTIVE_STATUSES.includes(run.status)) throw new Error("cannot_rerun_while_job_active");
    let prevHash: string | null = null;
    if (idx > 0) {
      const before = view.runs[plan[idx - 1]!.stage];
      if (before?.status !== "succeeded") throw new Error("run the earlier stage first");
      prevHash = before.inputHash;
    }
    const want = expectedInputHash(view, stage, prevHash);
    if (run?.status === "succeeded" && run.inputHash === want) throw new Error("nothing changed since this stage last succeeded");
    const id = await insertRun(c, videoId, stage, want);
    if (!id) throw new Error("cannot_rerun_while_job_active");
    await c.query("update videos set status = 'active', updated_at = now() where id = $1", [videoId]);
    return [{ id, inputHash: want }];
  });
  return { ...(await deliver(queue, created)), action: null };
}

/** Stops the video and flags every active stage. A queued stage is closed at once; a running one stops at its worker. */
export async function cancelVideo(db: pg.Pool, videoId: string): Promise<{ flagged: string[] }> {
  const flagged = await inTx(db, async (c) => {
    await lockVideo(c, videoId);
    await c.query("update videos set status = 'cancelled', updated_at = now() where id = $1", [videoId]);
    const active = await c.query<{ id: string }>("select id from stage_runs where video_id = $1 and status in ('queued','running','needs_decision') order by id", [videoId]);
    const ids: string[] = [];
    for (const { id } of active.rows) if (await requestCancel(c, id)) ids.push(id);
    return ids;
  });
  for (const id of flagged) await cancelQueuedStage(db, id);
  return { flagged };
}
