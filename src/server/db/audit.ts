import { isAuditEvent, redactDetail, type AuditEvent } from "@/server/core/audit-events";
import type { Db } from "@/server/db/stages";

// Shared audit writer. INSERT and SELECT only: the app role has no update/delete/truncate on audit_log (migration 0004),
// and nothing here needs them. Secrets never reach the row: see redactDetail.

/**
 * Writes one audit row. Secret-looking keys/values are blanked, and only the key names (never values) are logged.
 * `failOnSecret` is for legacy callers that want a loud failure outside production. Prefer recordAudit.
 */
export async function insertAudit(
  db: Db,
  event: string,
  detail: Record<string, unknown> = {},
  opts: { failOnSecret?: boolean } = {},
): Promise<void> {
  const { safe, redacted } = redactDetail(detail);
  if (redacted.length > 0 && opts.failOnSecret && process.env.NODE_ENV !== "production") {
    throw new Error("audit detail contains a secret-looking value");
  }
  for (const key of redacted) console.error(JSON.stringify({ event: "audit.redacted", key }));
  await db.query("insert into audit_log (event, detail) values ($1, $2::jsonb)", [event, JSON.stringify(safe)]);
}

/** The event must be in the catalogue (compile time and runtime). */
export async function recordAudit(db: Db, event: AuditEvent, detail: Record<string, unknown> = {}): Promise<void> {
  if (!isAuditEvent(event)) throw new RangeError("unknown audit event");
  await insertAudit(db, event, detail);
}

export interface AuditRow {
  id: string; // bigserial: pg returns a string
  at: Date;
  event: string;
  detail: Record<string, unknown> | null;
}

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/** Newest first. `before` is the `next` cursor of the previous page (an id); `next` is null on the last page. */
export async function listAudit(
  db: Db,
  opts: { before?: string; limit?: number; eventPrefix?: string } = {},
): Promise<{ rows: AuditRow[]; next: string | null }> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit must be a positive integer");
  if (opts.before !== undefined && !/^[0-9]{1,18}$/.test(opts.before)) throw new RangeError("invalid cursor");
  const take = Math.min(limit, MAX_LIMIT);
  const prefix = opts.eventPrefix ?? "";
  // left() compares literally, so % and _ in a prefix are not LIKE wildcards.
  const { rows } = await db.query<AuditRow>(
    `select id::text as id, at, event, detail from audit_log
      where ($1::bigint is null or id < $1::bigint)
        and ($2 = '' or left(event, length($2)) = $2)
      order by id desc limit $3`,
    [opts.before ?? null, prefix, take + 1],
  );
  const more = rows.length > take;
  const page = more ? rows.slice(0, take) : rows;
  return { rows: page, next: more ? page[page.length - 1]!.id : null };
}
