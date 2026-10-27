import { redactLine } from "@/server/core/log-redact";
import type { StreamEvent } from "@/server/queue/event-stream";
import type { Db } from "./stages";

// The live feed table (migration 0016). Insert, then best-effort wake-up. Postgres is the truth: a lost wake-up only
// delays delivery until the next poll.
export const EVENT_TYPES = [
  "stage.started", "stage.succeeded", "stage.failed", "stage.needs_decision", "stage.cancelled",
  "gate.waiting", "gate.approved", "gate.sent_back",
  "video.created", "video.done", "video.failed",
  "log", "notify",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];
export const EVENT_PAYLOAD_MAX_BYTES = 4096;

export class EventPayloadTooLargeError extends Error {
  constructor(public readonly bytes: number) {
    super(`event payload is ${bytes} bytes; the limit is ${EVENT_PAYLOAD_MAX_BYTES}`);
    this.name = "EventPayloadTooLargeError";
  }
}

export interface NewEvent {
  type: EventType;
  videoId?: string | null;
  stageRunId?: string | null;
  payload?: Record<string, unknown>;
}
export interface WakeBus {
  publish(id: number): Promise<void>;
}

// The whole payload goes through the same redaction as log lines (key-aware for JSON), so no event carries a credential shape.
const scrub = (payload: Record<string, unknown>): string => redactLine(JSON.stringify(payload));

/** Inserts the row only (usable inside a transaction). Throws on an unknown type or an oversized payload. */
export async function insertEvent(db: Db, e: NewEvent): Promise<number> {
  if (!(EVENT_TYPES as readonly string[]).includes(e.type)) throw new RangeError("unknown event type");
  const json = scrub(e.payload ?? {});
  const size = Buffer.byteLength(json);
  if (size > EVENT_PAYLOAD_MAX_BYTES) throw new EventPayloadTooLargeError(size);
  const { rows } = await db.query<{ id: string }>(
    "insert into events (video_id, stage_run_id, type, payload) values ($1, $2, $3, $4::jsonb) returning id",
    [e.videoId ?? null, e.stageRunId ?? null, e.type, json],
  );
  return Number(rows[0]!.id);
}

/** Insert, then a best-effort Redis wake-up carrying only the id. A dead Redis never fails the caller. */
export async function emitEvent(db: Db, bus: WakeBus | undefined, e: NewEvent): Promise<number> {
  const id = await insertEvent(db, e);
  try { await bus?.publish(id); } catch { /* the poll fallback delivers it */ }
  return id;
}

export async function listEventsSince(db: Db, after: number, limit = 200): Promise<StreamEvent[]> {
  const { rows } = await db.query(
    "select id, at, video_id, stage_run_id, type, payload from events where id > $1 order by id limit $2",
    [after, limit],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    at: (r.at as Date).toISOString(),
    videoId: r.video_id,
    stageRunId: r.stage_run_id,
    type: r.type,
    payload: r.payload,
  }));
}

export async function latestEventId(db: Db): Promise<number> {
  const { rows } = await db.query<{ id: string | null }>("select max(id) as id from events");
  return Number(rows[0]?.id ?? 0);
}

/** Retention: rows older than 7 days, through the owner-granted function (the app role cannot delete from events). */
export async function pruneEvents(db: Db): Promise<number> {
  const { rows } = await db.query<{ n: string }>("select prune_events() as n");
  return Number(rows[0]!.n);
}
