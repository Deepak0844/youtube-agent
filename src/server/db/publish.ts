import type pg from "pg";
import { actorProblem, ACTOR_REASON, type GateActor } from "@/server/core/approvals";
import { metadataProblem, publishPolicyProblem, visibilityProblem, type Visibility } from "@/server/core/publish-rules";
import { uuidv7 } from "@/server/core/ids";
import { approvalState, approveGateWith, readSnapshot, type ContentVersions } from "@/server/db/approvals";
import { recordAudit } from "@/server/db/audit";
import { getSetting } from "@/server/db/settings";
import type { UploadTarget } from "@/server/providers/uploader";
import type { UploadQueue } from "@/server/queue/job-queue";
import { hashStoredFile, StoredFileError } from "@/server/storage/hash-file";
import { storageRoot } from "@/server/storage/paths";

// Publish approval and the facts an upload job must re-prove (Task 21, ADR 0004). Two entry points:
//   approvePublish    owner session only; ONE transaction under the video lock: hash re-check, policy, file bytes, upload row.
//   readUploadTarget  job time: reads approval + content in ONE repeatable-read snapshot, then hashes the real file.
// The job payload is only an upload id; every other fact is read here. Nothing here starts an upload.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH_RE = /^[0-9a-f]{64}$/;
const MAX_CHANNEL = 200;
const short = (h: string) => h.slice(0, 12);

export type ApprovePublishResult = { ok: true; approvalId: string; uploadId: string; queued: boolean } | { ok: false; reason: string };
export interface PublishArgs {
  videoId: string;
  seenHash: string;
  visibility: Visibility;
  publishAt: string | null;
  channelId: string;
  actor: GateActor;
}

const refuse = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

async function sessionIsLive(db: pg.PoolClient, sessionId: string): Promise<boolean> {
  const r = await db.query(
    "select 1 from sessions where id = $1 and revoked_at is null and expires_at > clock_timestamp() and absolute_expires_at > clock_timestamp()",
    [sessionId],
  );
  return r.rowCount === 1;
}
const dbNowMs = async (db: pg.PoolClient): Promise<number> => Number((await db.query<{ ms: string }>("select (extract(epoch from clock_timestamp()) * 1000)::bigint::text as ms")).rows[0]!.ms);
/** The settings and sibling approvals the policy needs, read one after another on the caller's client. */
async function policyFacts(client: pg.PoolClient, videoId: string) {
  const allowPublic = await getSetting(client, "policy.allow_public");
  const requireEvidence = await getSetting(client, "policy.require_evidence");
  const videoApproved = (await approvalState(client, videoId, "video")).approved;
  const evidenceApproved = (await approvalState(client, videoId, "evidence")).approved;
  return { allowPublic, requireEvidence, videoApproved, evidenceApproved, nowMs: await dbNowMs(client) };
}
const fileProblem = (e: unknown): string => (e instanceof StoredFileError ? `the video file cannot be used: ${e.message}` : "the video file cannot be read");

/**
 * The owner approves exactly what was shown: hash, visibility, schedule and channel. In one transaction (and under the
 * video lock) it re-checks the hash, the policy (kill switch, evidence, video approval, 60-minute lead), that the session
 * is real and unexpired, and that the file's real bytes match the stored sha256; then writes the approval and the
 * `publish_approved` upload row together. The job is enqueued after commit; a failed enqueue leaves `queued: false`
 * (the approval stands; `requeueUpload` re-sends it). Refuses; never throws for a refusal.
 */
export async function approvePublish(db: pg.Pool, queue: Pick<UploadQueue, "enqueueUpload">, a: PublishArgs, opts: { root?: string } = {}): Promise<ApprovePublishResult> {
  if (actorProblem(a?.actor)) return refuse(ACTOR_REASON);
  if (typeof a.videoId !== "string" || !UUID_RE.test(a.videoId)) return refuse("video not found");
  if (typeof a.seenHash !== "string" || !HASH_RE.test(a.seenHash)) return refuse("this changed while you were looking; review again");
  if (visibilityProblem(a.visibility)) return refuse("visibility must be private, unlisted or public");
  if (typeof a.channelId !== "string" || a.channelId.trim() === "" || a.channelId.length > MAX_CHANNEL) return refuse("choose a channel before publishing");
  const root = opts.root ?? storageRoot();
  const sessionId = a.actor.sessionId;

  const res = await approveGateWith(db, { videoId: a.videoId, gate: "publish", seenHash: a.seenHash, actor: a.actor }, {
    async guard(client, snap) {
      if (!(await sessionIsLive(client, sessionId))) return ACTOR_REASON;
      const meta = snap.inputs.content.metadata;
      const video = snap.inputs.content.video;
      if (!meta || !video) return "nothing to approve yet";
      const problem = metadataProblem(meta.body);
      if (problem) return problem;
      const body = meta.body as Record<string, unknown>;
      // What the owner saw must be what is stored; the hash already covers these, so a mismatch is a caller bug or a replay.
      if (body.visibility !== a.visibility || (body.publish_at ?? null) !== (a.publishAt ?? null) || snap.inputs.channelId !== a.channelId) {
        return "the visibility, schedule or channel does not match what is stored; review again";
      }
      const prior = await client.query<{ status: string; approval_hash: string | null }>("select status, approval_hash from uploads where video_id = $1", [a.videoId]);
      if (prior.rows.some((r) => r.status !== "publish_approved" || r.approval_hash === snap.live.hash)) {
        return "an upload for this video is already approved, running or finished; check the queue before approving again";
      }
      const policy = publishPolicyProblem({ visibility: body.visibility, publishAt: body.publish_at ?? null, ...(await policyFacts(client, a.videoId)), phase: "approve" });
      if (policy) return policy;
      if (video.filePath == null) return "the video file cannot be used: it is not a stored file";
      try {
        const h = await hashStoredFile(root, video.filePath);
        if (h.sha256 !== video.sha256) return "the video file on disk is not the file that was reviewed; render it again";
      } catch (e) {
        return fileProblem(e);
      }
      return null;
    },
    async after(client, { approvalId, snap }) {
      const uploadId = uuidv7();
      const video = snap.inputs.content.video!;
      await client.query(
        "insert into uploads (id, video_id, status, approval_hash, file_sha, channel_id) values ($1, $2, 'publish_approved', $3, $4, $5)",
        [uploadId, a.videoId, snap.live.hash, video.sha256, a.channelId],
      );
      const meta = snap.inputs.content.metadata!.body as Record<string, unknown>;
      await recordAudit(client, "publish.approved", {
        videoId: a.videoId, approvalId, uploadId, hashPrefix: short(snap.live.hash), fileShaPrefix: short(video.sha256),
        versions: snap.versions, visibility: meta.visibility, publishAt: meta.publish_at ?? null, sessionId,
      });
      return { uploadId };
    },
  });
  if (!res.ok) return res;
  let queued = true;
  try {
    await queue.enqueueUpload(res.extra.uploadId);
  } catch {
    queued = false;
  }
  return { ok: true, approvalId: res.approvalId, uploadId: res.extra.uploadId, queued };
}

/** Sends the job again for an approved upload that never reached the queue. Only `publish_approved` rows; a no-op otherwise. */
export async function requeueUpload(db: pg.Pool, queue: Pick<UploadQueue, "enqueueUpload">, uploadId: string): Promise<boolean> {
  if (typeof uploadId !== "string" || !UUID_RE.test(uploadId)) return false;
  const r = await db.query("select 1 from uploads where id = $1 and status = 'publish_approved'", [uploadId]);
  if (r.rowCount !== 1) return false;
  await queue.enqueueUpload(uploadId);
  return true;
}

export type TargetRefusal = "not_found" | "not_publish_approved" | "approval_changed" | "approval_session_invalid" | "policy" | "file_changed" | "no_channel";
export interface VerifiedTarget {
  uploadId: string;
  approvalId: string;
  /** The live approval hash (never taken from the job payload or the upload row). */
  approvalHash: string;
  /** sha256 of the file's real bytes, read just now and equal to the stored sha of the approved video version. */
  fileSha: string;
  versions: ContentVersions;
  target: UploadTarget;
}
export type TargetResult = { ok: true; value: VerifiedTarget } | { ok: false; reason: TargetRefusal; detail?: string };

/**
 * Job time. One REPEATABLE READ snapshot reads the upload row, the derived approval (approvalState), the content versions
 * it covers, the approving session, the policy settings and the metadata; so the hash, version ids and file path all
 * belong to one moment. The real file is then hashed and must equal the stored sha256 of THAT version.
 */
export async function readUploadTarget(db: pg.Pool, uploadId: string, opts: { root?: string } = {}): Promise<TargetResult> {
  if (typeof uploadId !== "string" || !UUID_RE.test(uploadId)) return { ok: false, reason: "not_found" };
  const root = opts.root ?? storageRoot();
  const client = await db.connect();
  let snap;
  try {
    await client.query("begin isolation level repeatable read read only");
    const up = (await client.query<{ video_id: string; status: string; channel_id: string | null }>("select video_id, status, channel_id from uploads where id = $1", [uploadId])).rows[0];
    if (!up) return { ok: false, reason: "not_found" };
    if (up.status !== "publish_approved") return { ok: false, reason: "not_publish_approved" };
    if (up.channel_id === null) return { ok: false, reason: "no_channel" };
    const state = await approvalState(client, up.video_id, "publish");
    if (!state.approved) return { ok: false, reason: "approval_changed" };
    const s = await readSnapshot(client, up.video_id, "publish");
    if (s === "no_video" || !s.live.ok || s.live.hash !== state.hash) return { ok: false, reason: "approval_changed" };
    const meta = s.inputs.content.metadata;
    const video = s.inputs.content.video;
    if (!meta || !video || video.filePath == null || metadataProblem(meta.body) || s.inputs.channelId !== up.channel_id) return { ok: false, reason: "approval_changed" };
    const ap = (await client.query<{ id: string; content_hash: string; valid: boolean }>(
      `select a.id, a.content_hash,
              exists (select 1 from sessions s where s.id = a.session_id and a.decided_at < s.expires_at and a.decided_at < s.absolute_expires_at
                                  and (s.revoked_at is null or s.revoked_at > a.decided_at)) as valid
         from approvals a where a.video_id = $1 and a.gate = 'publish' and a.decision = 'approved' order by a.seq desc limit 1`,
      [up.video_id],
    )).rows[0];
    if (!ap || ap.content_hash !== state.hash) return { ok: false, reason: "approval_changed" };
    if (!ap.valid) return { ok: false, reason: "approval_session_invalid" };
    const body = meta.body as Record<string, unknown>;
    const policy = publishPolicyProblem({ visibility: body.visibility, publishAt: body.publish_at ?? null, ...(await policyFacts(client, up.video_id)), phase: "upload" });
    if (policy) return { ok: false, reason: "policy", detail: policy };
    snap = { up, state, video, body, approvalId: ap.id, channelId: up.channel_id };
    await client.query("commit");
  } finally {
    // Every early return above leaves the read-only snapshot open: end it before the connection goes back to the pool,
    // or the next user of this connection would run inside a stale read-only transaction. (A no-op after commit.)
    await client.query("rollback").catch(() => undefined);
    client.release();
  }
  // Outside the transaction (file IO can be slow). The content rows are append-only for the app role, so the version
  // id fixed in the snapshot still names the same path and sha256.
  let h;
  try {
    h = await hashStoredFile(root, snap.video.filePath!);
  } catch (e) {
    return { ok: false, reason: "file_changed", detail: fileProblem(e) };
  }
  if (h.sha256 !== snap.video.sha256) return { ok: false, reason: "file_changed", detail: "the file bytes do not match the reviewed version" };
  return {
    ok: true,
    value: {
      uploadId, approvalId: snap.approvalId, approvalHash: snap.state.hash, fileSha: h.sha256, versions: snap.state.versions,
      target: {
        videoId: snap.up.video_id, filePath: snap.video.filePath!, fileSha256: h.sha256, bytes: h.bytes, channelId: snap.channelId,
        visibility: snap.body.visibility as Visibility, publishAt: (snap.body.publish_at ?? null) as string | null,
      },
    },
  };
}
