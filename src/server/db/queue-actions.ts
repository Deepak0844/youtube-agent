import type pg from "pg";
import { captionsNeedTick, actorProblem, ACTOR_REASON, type GateActor } from "@/server/core/approvals";
import { STALE_MESSAGE, versionsKey, type BreakerStage, type DecisionInput, type GateInput } from "@/server/core/queue-input";
import { approvalReaders } from "@/server/db/approval-readers";
import { canonicalJson, sha256Hex } from "@/server/core/content-hash";
import { approveGate, liveGateHash, readSnapshot, sendBack } from "@/server/db/approvals";
import { recordAudit } from "@/server/db/audit";
import { resetBreaker } from "@/server/db/breakers";
import { getDecision, resolveDecision } from "@/server/db/decision";
import { checkParkedJob } from "@/server/db/job-check";
import type { JobCheckers } from "@/server/providers/media-types";
import { DRY_RUN_NOTES } from "@/lib/dry-run";
import { advanceVideo, cancelVideo, createVideo, readNextAction, type EnqueueOnly } from "@/server/db/pipeline";
import { approvePublish, requeueUpload } from "@/server/db/publish";
import { dryRunRefusal } from "@/worker/stages/guard";
import type { UploadQueue } from "@/server/queue/job-queue";

// What the /queue buttons do, minus the framework: the caller (actions.ts) has already run requireOwner() and passes the
// session as `actor`. Every function re-checks the actor shape, compares what the page RENDERED (hash, content versions,
// the dollar figure) with the live state, and only then calls the core that owns the rule. A refusal is a sentence the
// owner can read; nothing here throws for a refusal.

export interface ActionResult {
  ok: boolean;
  message: string;
}
export interface Queues {
  stage: EnqueueOnly;
  upload: Pick<UploadQueue, "enqueueUpload">;
}

const refuse = (message: string): ActionResult => ({ ok: false, message });
const NOT_WAITING = "This is no longer waiting for you.";

function say(reason: string): string {
  if (reason.includes("changed while you were looking")) return STALE_MESSAGE;
  return reason.charAt(0).toUpperCase() + reason.slice(1) + (/[.!?]$/.test(reason) ? "" : ".");
}

/** Best effort: the worker's sweep also advances videos, so a Redis outage here only delays the next stage. */
async function advance(db: pg.Pool, queue: EnqueueOnly, videoId: string): Promise<void> {
  try {
    await advanceVideo(db, queue, videoId, approvalReaders);
  } catch {
    /* the sweep picks it up */
  }
}

/**
 * Approximate captions need the owner's tick before the video can be approved. The tick is a new captions version, which is
 * hashed with the video: it is audited, and a later rewrite (a new captions version) voids it. Returns the new live hash when it ticked.
 */
export async function tickCaptions(
  db: pg.Pool,
  videoId: string,
  actor: GateActor,
  checked: boolean,
  seen: { captionsId: string | undefined; videoId: string | undefined },
): Promise<{ ok: true; hash?: string } | { ok: false; message: string }> {
  if (actorProblem(actor)) return { ok: false, message: ACTOR_REASON };
  const snap = await readSnapshot(db, videoId, "video");
  if (snap === "no_video" || !snap.inputs.content.captions || !captionsNeedTick(snap.inputs.content.captions.body)) return { ok: true };
  if (!checked) return { ok: false, message: "Tick \"I checked the captions\" first. The captions are approximate: listen and check." };
  // Under the same per-video, per-kind lock every version insert takes, and re-read inside it: two clicks at once add ONE tick, and
  // only the captions and video the owner SAW can be ticked (a newer version landing in between is refused as changed).
  let expectCaptions: string | undefined;
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`video_content:${videoId}:captions`]);
    const cur = await client.query<{ id: string; body: Record<string, unknown> }>("select id, body from video_content where video_id = $1 and kind = 'captions' order by version desc limit 1", [videoId]);
    const vid = await client.query<{ id: string }>("select id from video_content where video_id = $1 and kind = 'video' order by version desc limit 1", [videoId]);
    if ((seen.captionsId && cur.rows[0]?.id !== seen.captionsId) || (seen.videoId && vid.rows[0]?.id !== seen.videoId)) {
      await client.query("rollback");
      return { ok: false, message: STALE_MESSAGE };
    }
    let captionsAfter = cur.rows[0]?.id;
    if (cur.rows[0] && captionsNeedTick(cur.rows[0].body)) {
      const body = { ...cur.rows[0].body, checked_by_owner: true };
      const ins = await client.query<{ id: string }>(
        `insert into video_content (video_id, kind, version, sha256, body) values ($1, 'captions', (select coalesce(max(version), 0) + 1 from video_content where video_id = $1 and kind = 'captions'), $2, $3) returning id`,
        [videoId, sha256Hex(canonicalJson(body)), JSON.stringify(body)],
      );
      captionsAfter = ins.rows[0]!.id;
      await recordAudit(client, "captions.checked", { videoId, sessionId: actor.sessionId });
    }
    await client.query("commit");
    expectCaptions = captionsAfter;
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
  // The hash is read after the commit, so it only counts if it covers exactly the video the owner saw and the tick row just written.
  const fresh = await liveGateHash(db, videoId, "video");
  if (!fresh || fresh.versions.video?.id !== seen.videoId || fresh.versions.captions?.id !== expectCaptions) return { ok: false, message: STALE_MESSAGE };
  return { ok: true, hash: fresh.hash };
}

export async function decideGate(db: pg.Pool, q: Queues, actor: GateActor, i: GateInput, kind: "approve" | "send_back", opts: { root?: string } = {}): Promise<ActionResult> {
  if (actorProblem(actor)) return refuse(ACTOR_REASON);
  const status = await db.query<{ status: string }>("select status from videos where id = $1", [i.videoId]);
  if (!["active", "waiting"].includes(status.rows[0]?.status ?? "")) return refuse("This video is no longer in production.");
  // Only the gate the pipeline is waiting at right now can be decided (a stale tab, or a hand-made post for another gate, is refused).
  const next = await readNextAction(db, i.videoId, approvalReaders);
  if (next?.kind !== "wait_gate" || next.gate !== i.gate) return refuse(NOT_WAITING);
  const live = await liveGateHash(db, i.videoId, i.gate);
  if (!live || live.hash !== i.seenHash || versionsKey(live.versions) !== i.seenVersions) return refuse(STALE_MESSAGE);

  if (kind === "send_back") {
    const r = await sendBack(db, { videoId: i.videoId, gate: i.gate, seenHash: i.seenHash, note: i.note ?? "", actor });
    if (!r.ok) return refuse(say(r.reason));
    if (i.gate === "script") await advance(db, q.stage, i.videoId);
    return { ok: true, message: i.gate === "script" ? "Sent back. A new draft will follow your note." : "Sent back. This video is held until it is rebuilt or cancelled." };
  }

  if (i.gate === "publish") {
    // Visibility, schedule and channel come from the very rows the hash covers; approvePublish re-checks them in its transaction.
    const snap = await readSnapshot(db, i.videoId, "publish");
    if (snap === "no_video" || !snap.live.ok || snap.live.hash !== i.seenHash) return refuse(STALE_MESSAGE);
    const meta = (snap.inputs.content.metadata?.body ?? {}) as Record<string, unknown>;
    const r = await approvePublish(
      db,
      q.upload,
      { videoId: i.videoId, seenHash: i.seenHash, visibility: meta.visibility as "private" | "unlisted" | "public", publishAt: typeof meta.publish_at === "string" ? meta.publish_at : null, channelId: snap.inputs.channelId ?? "", actor },
      opts,
    );
    if (!r.ok) return refuse(say(r.reason));
    await advance(db, q.stage, i.videoId);
    return { ok: true, message: r.queued ? "Approved. The upload is queued." : "Approved. The upload could not be queued just now; use Send again below." };
  }

  let seenHash = i.seenHash;
  if (i.gate === "video") {
    const t = await tickCaptions(db, i.videoId, actor, i.captionsChecked === true, { captionsId: live.versions.captions?.id, videoId: live.versions.video?.id });
    if (!t.ok) return refuse(t.message);
    if (t.hash) seenHash = t.hash;
  }
  const r = await approveGate(db, { videoId: i.videoId, gate: i.gate, seenHash, actor });
  if (!r.ok) return refuse(say(r.reason));
  await advance(db, q.stage, i.videoId);
  return { ok: true, message: "Approved." };
}

export async function decideParkedStage(db: pg.Pool, q: Queues, actor: GateActor, i: DecisionInput, checkers: JobCheckers = {}): Promise<ActionResult> {
  if (actorProblem(actor)) return refuse(ACTOR_REASON);
  const detail = await getDecision(db, i.stageRunId, new Set(Object.keys(checkers)));
  if (!detail) return refuse(NOT_WAITING);
  if (detail.maxCostMicroUsd !== i.seenMaxMicroUsd || detail.reason !== i.seenReason) return refuse(STALE_MESSAGE);
  if (!detail.choices.includes(i.choice)) return refuse("That choice is not available for this step.");
  if (i.choice === "check_the_job") {
    const c = await checkParkedJob(db, checkers, { stageRunId: i.stageRunId, actor });
    return c.ok ? { ok: c.outcome === "done" || c.outcome === "already_done" || c.outcome === "running", message: c.message } : refuse(say(c.message));
  }
  // Saying "nothing was charged" (or "count it as spent") releases money: it needs the owner's explicit confirmation.
  if ((i.choice === "release_and_rerun" || i.choice === "keep_spent_and_rerun") && !i.confirmed) return refuse("Tick the box to confirm you checked the provider's billing page.");
  const r = await resolveDecision(db, q.stage, { stageRunId: i.stageRunId, choice: i.choice, actor }, approvalReaders);
  if (!r.ok) return refuse(say(r.reason));
  return { ok: true, message: i.choice === "cancel_video" ? "Video cancelled." : "Done. The step will run again." };
}

export async function cancelVideoById(db: pg.Pool, actor: GateActor, videoId: string): Promise<ActionResult> {
  if (actorProblem(actor)) return refuse(ACTOR_REASON);
  try {
    await cancelVideo(db, videoId);
  } catch {
    return refuse("That video could not be found.");
  }
  await recordAudit(db, "video.cancelled", { videoId, sessionId: actor.sessionId });
  return { ok: true, message: "Video cancelled." };
}

export async function resetBreakerFor(db: pg.Pool, actor: GateActor, stage: BreakerStage): Promise<ActionResult> {
  if (actorProblem(actor)) return refuse(ACTOR_REASON);
  const r = await resetBreaker(db, stage, actor);
  return r.ok ? { ok: true, message: "Released. Waiting videos can start again." } : refuse(say(r.reason));
}

export async function sendUploadAgain(db: pg.Pool, q: Queues, actor: GateActor, uploadId: string): Promise<ActionResult> {
  if (actorProblem(actor)) return refuse(ACTOR_REASON);
  let sent = false;
  try {
    sent = await requeueUpload(db, q.upload, uploadId);
  } catch {
    return refuse("The upload queue is not reachable right now. Try again in a minute.");
  }
  if (!sent) return refuse(NOT_WAITING);
  await recordAudit(db, "upload.requeued", { uploadId, sessionId: actor.sessionId });
  return { ok: true, message: "Sent to the uploader again." };
}

/** Development helper: a plain short video the engine picks up. Real providers decide what it costs; the dry-run handlers (Task 20) make it free. */
export async function startDryRun(db: pg.Pool, q: Queues, actor: GateActor, env: Record<string, string | undefined> = process.env): Promise<ActionResult> {
  if (actorProblem(actor)) return refuse(ACTOR_REASON);
  // Same guard the worker applies before it will use fake providers: opt-in, not production, throwaway database, no stored provider key.
  const why = await dryRunRefusal(db, env as NodeJS.ProcessEnv).catch(() => "The dry run guard could not check the database.");
  if (why) return refuse(why);
  const v = await createVideo(db, { format: "short", kind: "scene_kit", language: "en", topic: "Dry run: why the sky is blue", notes: DRY_RUN_NOTES });
  await recordAudit(db, "dryrun.started", { videoId: v.id, sessionId: actor.sessionId });
  await advance(db, q.stage, v.id);
  return { ok: true, message: "Dry run started." };
}
