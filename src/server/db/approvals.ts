import type pg from "pg";
import { ACTOR_REASON, GATE_KINDS, actorProblem, isImplementedGate, liveHash, noteProblem, type GateActor, type GateContentKind, type ImplementedGate, type LiveHash, type LiveInputs } from "@/server/core/approvals";
import type { GateId } from "@/server/core/gates";
import { recordAudit } from "@/server/db/audit";
import type { Db } from "@/server/db/stages";

// Hash-bound gate decisions (Doc 02 4.4). Approvals are append-only; whether a gate is approved is DERIVED on every read:
// the newest decision is 'approved' AND its stored hash equals the live hash now. A new content version voids it with nothing
// to remember to update. Session-only: the actor type has one legal value and the runtime refuses anything else.

export type GateResult = { ok: true; approvalId: string } | { ok: false; reason: string };
/** kind -> the exact video_content row the hash was computed from. */
export type ContentVersions = Partial<Record<GateContentKind, { id: string; version: number }>>;
export interface LiveGateHash {
  hash: string;
  versions: ContentVersions;
}
export type ApprovalState = { approved: true; hash: string; versions: ContentVersions } | { approved: false };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH_RE = /^[0-9a-f]{64}$/;
const STALE_REASON = "this changed while you were looking; review again";

const refuse = (reason: string): GateResult => ({ ok: false, reason });

interface Snapshot {
  live: LiveHash;
  versions: ContentVersions;
  last: { decision: string; hash: string; versions: ContentVersions } | null;
}

/**
 * ONE statement = one snapshot: the video, the newest content of every kind the gate covers, and the newest decision for the
 * gate are read together, so the hash, the version ids and the decision always belong to the same moment. Callers that need
 * more (Task 21 upload) pass a client inside a REPEATABLE READ transaction.
 */
async function readSnapshot(db: Db, videoId: string, gate: ImplementedGate): Promise<Snapshot | "no_video"> {
  const kinds = GATE_KINDS[gate];
  const r = await db.query<{
    channel_id: string | null;
    content: Array<{ id: string; kind: GateContentKind; version: number; sha256: string; body: unknown; file_path: string | null }>;
    last: { decision: string; content_hash: string; versions: ContentVersions } | null;
  }>(
    `select v.channel_id,
            coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'kind', c.kind, 'version', c.version, 'sha256', c.sha256, 'body', c.body, 'file_path', c.file_path))
                        from (select distinct on (kind) id, kind, version, sha256, body, file_path
                                from video_content where video_id = v.id and kind = any($2) order by kind, version desc) c), '[]'::jsonb) as content,
            (select jsonb_build_object('decision', a.decision, 'content_hash', a.content_hash, 'versions', a.content_versions)
               from approvals a where a.video_id = v.id and a.gate = $3 order by a.seq desc limit 1) as last
       from videos v where v.id = $1`,
    [videoId, [...kinds], gate],
  );
  const row = r.rows[0];
  if (!row) return "no_video";
  const inputs: LiveInputs = { channelId: row.channel_id, content: {} };
  const versions: ContentVersions = {};
  for (const c of row.content) {
    inputs.content[c.kind] = { sha256: c.sha256, body: c.body, filePath: c.file_path };
    versions[c.kind] = { id: c.id, version: c.version };
  }
  return { live: liveHash(gate, inputs), versions, last: row.last ? { decision: row.last.decision, hash: row.last.content_hash, versions: row.last.versions } : null };
}

/** The hash the owner would be approving right now with the exact content versions it covers, or null when it cannot be approved yet. */
export async function liveGateHash(db: Db, videoId: string, gate: GateId): Promise<LiveGateHash | null> {
  if (!isImplementedGate(gate) || !UUID_RE.test(videoId)) return null;
  const s = await readSnapshot(db, videoId, gate);
  return s !== "no_video" && s.live.ok ? { hash: s.live.hash, versions: s.versions } : null;
}

/** Derived, in one snapshot: approved only if the newest decision is 'approved' and its hash equals the live hash. Returns that hash and versions. */
export async function approvalState(db: Db, videoId: string, gate: GateId): Promise<ApprovalState> {
  if (!isImplementedGate(gate) || !UUID_RE.test(videoId)) return { approved: false };
  const s = await readSnapshot(db, videoId, gate);
  if (s === "no_video" || !s.live.ok || !s.last || s.last.decision !== "approved" || s.last.hash !== s.live.hash) return { approved: false };
  return { approved: true, hash: s.live.hash, versions: s.versions };
}

interface Decision {
  videoId: string;
  gate: GateId;
  seenHash: string;
  actor: GateActor;
  note?: string;
}

async function decide(db: pg.Pool, d: Decision, decision: "approved" | "sent_back"): Promise<GateResult> {
  if (actorProblem(d.actor)) return refuse(ACTOR_REASON);
  if (!isImplementedGate(d.gate)) return refuse("this approval is not available yet");
  if (typeof d.videoId !== "string" || !UUID_RE.test(d.videoId)) return refuse("video not found");
  if (typeof d.seenHash !== "string" || !HASH_RE.test(d.seenHash)) return refuse(STALE_REASON);
  if (decision === "sent_back") {
    const np = noteProblem(d.note);
    if (np) return refuse(np);
  }
  const client = await db.connect();
  try {
    await client.query("begin");
    // Serialises every decision on this video; the live hash is read only after the lock is held.
    const locked = await client.query("select id from videos where id = $1 for update", [d.videoId]);
    if (locked.rows.length === 0) return await abort(client, "video not found");
    const snap = await readSnapshot(client, d.videoId, d.gate);
    if (snap === "no_video") return await abort(client, "video not found");
    if (!snap.live.ok) return await abort(client, snap.live.reason);
    const live = snap.live;
    if (live.hash !== d.seenHash) return await abort(client, STALE_REASON);
    if (decision === "approved" && snap.last?.decision === "sent_back" && snap.last.hash === live.hash) return await abort(client, "you sent this back; wait for the new version before approving");
    const ins = await client.query<{ id: string }>(
      "insert into approvals (video_id, gate, content_hash, content_versions, decision, note, decided_by, session_id) values ($1, $2, $3, $4::jsonb, $5, $6, 'session', $7) returning id",
      [d.videoId, d.gate, live.hash, JSON.stringify(snap.versions), decision, decision === "sent_back" ? d.note!.trim() : null, d.actor.sessionId],
    );
    await recordAudit(client, decision === "approved" ? "gate.approved" : "gate.sent_back", { videoId: d.videoId, gate: d.gate, hashPrefix: live.hash.slice(0, 8), sessionId: d.actor.sessionId });
    await client.query("commit");
    return { ok: true, approvalId: ins.rows[0]!.id };
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

async function abort(client: pg.PoolClient, reason: string): Promise<GateResult> {
  await client.query("rollback");
  return refuse(reason);
}

/** Approves exactly the content the owner saw. Refuses (never throws) for a wrong actor, stale hash or missing content; a database fault throws. */
export function approveGate(db: pg.Pool, a: { videoId: string; gate: GateId; seenHash: string; actor: GateActor }): Promise<GateResult> {
  return decide(db, a, "approved");
}

/** Sends the content back with a note for the rewrite. Same checks as approveGate. */
export function sendBack(db: pg.Pool, a: { videoId: string; gate: GateId; seenHash: string; note: string; actor: GateActor }): Promise<GateResult> {
  return decide(db, a, "sent_back");
}

/** Boolean form of approvalState. */
export async function isApproved(db: Db, videoId: string, gate: GateId): Promise<boolean> {
  return (await approvalState(db, videoId, gate)).approved;
}
