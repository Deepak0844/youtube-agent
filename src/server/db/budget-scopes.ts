import type pg from "pg";
import { BUDGET_DEFAULTS } from "@/server/core/settings-registry";
import { recordAudit } from "./audit";
import { atomic, toNumber } from "./stages";

// Budget scopes that limit one run, one video, one UTC day or one UTC month. The seeded rows (`draft_run`, `video:<kind>`,
// `day`, `month`, ...) are TEMPLATES: each scope below is a copy with the template's cap. Every stage that reserves money
// must get its scopes from here (not use the template rows directly: they would add up forever).
//
// "No limit" is a NULL cap. Postgres least() ignores NULL, so a copy of a no-limit template is no limit (NULL), a no-limit copy is
// lowered when its template later gets a figure, and a figure is never replaced by "no limit".
//
// On every call the copy's cap is brought down to the template's if the template was lowered (min of the two). A cap the
// owner RAISES in the template reaches new periods and new runs, not copies that already exist: raising is deliberate.

export const videoTemplate = (kind: string, format: string): string => (format === "long" ? "video:long" : `video:${kind}`);

export async function utcPeriods(db: pg.Pool): Promise<{ day: string; month: string }> {
  const t = await db.query<{ day: string; month: string }>(
    "select to_char(clock_timestamp() at time zone 'utc', 'YYYY-MM-DD') as day, to_char(clock_timestamp() at time zone 'utc', 'YYYY-MM') as month",
  );
  return t.rows[0]!;
}

/** Creates or lowers each copy and returns the scope names in order. Throws when a template row is missing. */
export async function ensureScopeCopies(db: pg.Pool, pairs: ReadonlyArray<readonly [scope: string, template: string]>): Promise<string[]> {
  await db.query(
    `insert into budgets (scope, cap_micro_usd)
     select p.scope, b.cap_micro_usd from unnest($1::text[], $2::text[]) as p(scope, template) join budgets b on b.scope = p.template
     on conflict (scope) do update set cap_micro_usd = least(budgets.cap_micro_usd, excluded.cap_micro_usd)`,
    [pairs.map((p) => p[0]), pairs.map((p) => p[1])],
  );
  const have = await db.query("select 1 from budgets where scope = any($1::text[])", [pairs.map((p) => p[0])]);
  if (have.rowCount !== pairs.length) throw new Error("budget caps are not set up");
  return pairs.map((p) => p[0]);
}

/**
 * A scope whose cap is a fixed figure that is not a template copy (an approved cost quote). Created on first use; later calls
 * can only LOWER the cap, never raise it, so re-running a stage cannot widen what the owner approved.
 */
export async function ensureCapScope(db: pg.Pool, scope: string, capMicroUsd: number): Promise<string> {
  if (!Number.isSafeInteger(capMicroUsd) || capMicroUsd < 0) throw new RangeError("a budget cap must be a whole, non-negative micro-USD amount");
  await db.query(
    `insert into budgets (scope, cap_micro_usd) values ($1, $2)
     on conflict (scope) do update set cap_micro_usd = least(budgets.cap_micro_usd, excluded.cap_micro_usd)`,
    [scope, capMicroUsd],
  );
  return scope;
}

/** `day:<date>` and `month:<yyyy-mm>` copies of the seeded `day` and `month` caps. */
export async function periodScopes(db: pg.Pool): Promise<[string, string][]> {
  const { day, month } = await utcPeriods(db);
  return [[`day:${day}`, "day"], [`month:${month}`, "month"]];
}

const MAX_CAP_MICRO_USD = 1e12;

/**
 * Sets a template's cap (`null` = no limit) and writes one audit row with the old and new figure, in one transaction.
 * Templates only (the ones in BUDGET_DEFAULTS): per-video, per-day and per-run copies are never edited here. The cap is
 * `null` or a whole micro-USD figure from 0 to 1e12; 0 is a real cap (refuses all spend), never "no limit".
 * Session only: the actor type is checked at run time too, because a token or system caller must never reach a cap.
 */
export async function setBudgetCap(db: pg.Pool, scope: string, cap: number | null, actor: "session" | "token" | "system"): Promise<void> {
  if (actor !== "session") throw new Error("a budget cap can only be changed by a logged-in session");
  if (!Object.hasOwn(BUDGET_DEFAULTS, scope)) throw new RangeError("unknown budget");
  if (cap !== null && (!Number.isSafeInteger(cap) || cap < 0 || cap > MAX_CAP_MICRO_USD)) {
    throw new RangeError("a budget cap must be a whole micro-USD amount from 0 to 1,000,000,000,000, or no limit");
  }
  await atomic(db, async (q) => {
    const cur = await q.query<{ cap: string | null }>("select cap_micro_usd as cap from budgets where scope = $1 for update", [scope]);
    const row = cur.rows[0];
    if (!row) throw new RangeError("unknown budget");
    await q.query("update budgets set cap_micro_usd = $2 where scope = $1", [scope, cap]);
    await recordAudit(q as pg.PoolClient, "budget.cap_changed", {
      scope,
      oldCapMicroUsd: row.cap === null ? null : toNumber(row.cap),
      newCapMicroUsd: cap,
    });
  });
}

export interface BudgetTemplate {
  scope: string;
  /** null = no limit. */
  capMicroUsd: number | null;
}
export interface PeriodTotals {
  reservedMicroUsd: number;
  spentMicroUsd: number;
}

/** Every template in display order, plus what is reserved and spent in the current UTC day and month (zero before the first call of a period). */
export async function listBudgetTemplates(db: pg.Pool): Promise<{ templates: BudgetTemplate[]; today: PeriodTotals; month: PeriodTotals }> {
  const names = Object.keys(BUDGET_DEFAULTS);
  const { day, month } = await utcPeriods(db);
  const { rows } = await db.query<{ scope: string; cap: string | null; reserved: string; spent: string }>(
    `select scope, cap_micro_usd as cap, reserved_micro_usd as reserved, spent_micro_usd as spent
       from budgets where scope = any($1::text[])`,
    [[...names, `day:${day}`, `month:${month}`]],
  );
  const by = new Map(rows.map((r) => [r.scope, r]));
  const totals = (scope: string): PeriodTotals => {
    const r = by.get(scope);
    return { reservedMicroUsd: r ? toNumber(r.reserved) : 0, spentMicroUsd: r ? toNumber(r.spent) : 0 };
  };
  return {
    templates: names.flatMap((scope) => {
      const r = by.get(scope);
      return r ? [{ scope, capMicroUsd: r.cap === null ? null : toNumber(r.cap) }] : [];
    }),
    today: totals(`day:${day}`),
    month: totals(`month:${month}`),
  };
}
