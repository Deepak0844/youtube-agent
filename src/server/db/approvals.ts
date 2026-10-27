import type pg from "pg";
import { ACTOR_REASON, actorProblem, isImplementedGate, liveHash, noteProblem, type GateActor, type ImplementedGate, type LiveHash, type LiveInputs } from "@/server/core/approvals";
import type { GateId } from "@/server/core/gates";
import { recordAudit } from "@/server/db/audit";
import type { Db } from "@/server/db/stages";

// Hash-bound gate decisions (Doc 02 4.4). Approvals are append-only; whether a gate is approved is DERIVED on every read:
// the newest decision is 'approved' AND its stored hash equals the live hash now. A new content version voids it with nothing
// to remember to update. Session-only: the actor type has one legal value and the runtime refuses anything else.

export type GateResult = { ok: true; approvalId: string } | { ok: false; reason: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH_RE = /^[0-9a-f]{64}$/;
const KINDS = ["script", "cost_plan", "video", "evidence", "metadata"] as const;
const STALE_REASON = "this changed while you were looking; review again";

const refuse = (reason: string): GateResult => ({ ok: false, reason });

/** Reads the newest content per kind (and the channel) and computes the live hash. Pass a locked client inside a decision. */
async function computeLive(db: Db, videoId: string, gate: ImplementedGate): Promise<LiveHash | "no_video"> {
  const v = await db.query<{ channel_id: string | null }>("select channel_id from videos where id = $1", [videoId]);
  if (v.rows.length === 0) return "no_video";
  const c = await db.query<{ kind: (typeof KINDS)[number]; sha256: string; body: unknown }>(
    "select distinct on (kind) kind, sha256, body from video_content where video_id = $1 and kind = any($2) order by kind, version desc",
    [videoId, [...KINDS]],
  );
  const inputs: LiveInputs = { channelId: v.rows[0]!.channel_id, content: {} };
  for (const r of c.rows) inputs.content[r.kind] = { sha256: r.sha256, body: r.body };
  return liveHash(gate, inputs);
}

/** The hash the owner would be approving right now, or null when the gate cannot be approved yet (missing parts, gate not built). */
export async function liveGateHash(db: Db, videoId: string, gate: GateId): Promise<string | null> {
  if (!isImplementedGate(gate) || !UUID_RE.test(videoId)) return null;
  const r = await computeLive(db, videoId, gate);
  return r !== "no_video" && r.ok ? r.hash : null;
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
    const live = await computeLive(client, d.videoId, d.gate);
    if (live === "no_video") return await abort(client, "video not found");
    if (!live.ok) return await abort(client, live.reason);
    if (live.hash !== d.seenHash) return await abort(client, STALE_REASON);
    if (decision === "approved") {
      const last = await client.query<{ decision: string; content_hash: string }>(
        "select decision, content_hash from approvals where video_id = $1 and gate = $2 order by seq desc limit 1",
        [d.videoId, d.gate],
      );
      if (last.rows[0]?.decision === "sent_back" && last.rows[0].content_hash === live.hash) return await abort(client, "you sent this back; wait for the new version before approving");
    }
    const ins = await client.query<{ id: string }>(
      "insert into approvals (video_id, gate, content_hash, decision, note, decided_by) values ($1, $2, $3, $4, $5, 'session') returning id",
      [d.videoId, d.gate, live.hash, decision, decision === "sent_back" ? d.note!.trim() : null],
    );
    await recordAudit(client, decision === "approved" ? "gate.approved" : "gate.sent_back", { videoId: d.videoId, gate: d.gate, hashPrefix: live.hash.slice(0, 8) });
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

/** Derived: the newest decision is 'approved' and its hash equals the live hash now. */
export async function isApproved(db: Db, videoId: string, gate: GateId): Promise<boolean> {
  if (!isImplementedGate(gate) || !UUID_RE.test(videoId)) return false;
  const last = await db.query<{ decision: string; content_hash: string }>("select decision, content_hash from approvals where video_id = $1 and gate = $2 order by seq desc limit 1", [videoId, gate]);
  const row = last.rows[0];
  if (!row || row.decision !== "approved") return false;
  const live = await computeLive(db, videoId, gate);
  return live !== "no_video" && live.ok && live.hash === row.content_hash;
}
