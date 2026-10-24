import type pg from "pg";
import { uuidv7 } from "@/server/core/ids";
import { callKey } from "@/server/core/spend";
import { atomic, toNumber, type Claim, type Db } from "./stages";

// Spend intents + serialized budgets. Money is integer micro-USD (bigint in SQL, safe integer in TS).
// Lock order is always: budget rows in sorted scope order, then (for reserve) the stage row / (for settle)
// the intent row is locked FIRST. Reserve inserts a brand-new intent row nobody else can hold, so the
// two orders cannot form a cycle.

export type IntentStatus = "pending" | "done" | "failed_known" | "unknown";

export type ReserveResult =
  | { kind: "new"; intentId: string }
  | { kind: "existing"; status: IntentStatus; result?: unknown; intentId: string }
  | { kind: "refused"; reason: "cap" | "stale_fence" };

export interface Budget {
  scope: string;
  capMicroUsd: number;
  reservedMicroUsd: number;
  spentMicroUsd: number;
}

type Q = pg.ClientBase | pg.PoolClient;

function assertMicro(name: string, v: number): void {
  if (!Number.isSafeInteger(v) || v < 0) throw new RangeError(`${name} must be a non-negative safe integer, got ${v}`);
}

function normalizeScopes(scopes: string[]): string[] {
  if (scopes.length === 0 || scopes.some((s) => typeof s !== "string" || s.length === 0)) {
    throw new RangeError("budgetScopes must be a non-empty list of non-empty strings");
  }
  return [...new Set(scopes)].sort();
}

// Locks each scope row one at a time in sorted order; returns the rows that exist.
async function lockBudgets(q: Q, scopes: string[]): Promise<Map<string, { cap: bigint; reserved: bigint; spent: bigint }>> {
  const out = new Map<string, { cap: bigint; reserved: bigint; spent: bigint }>();
  for (const scope of scopes) {
    const { rows } = await q.query<{ cap: string; reserved: string; spent: string }>(
      `select cap_micro_usd as cap, reserved_micro_usd as reserved, spent_micro_usd as spent
         from budgets where scope = $1 for update`,
      [scope],
    );
    const r = rows[0];
    if (r) out.set(scope, { cap: BigInt(r.cap), reserved: BigInt(r.reserved), spent: BigInt(r.spent) });
  }
  return out;
}

async function readExisting(q: Q, key: string): Promise<ReserveResult | null> {
  const { rows } = await q.query<{ id: string; status: IntentStatus; result: unknown }>(
    "select id, status, result from spend_intents where call_key = $1",
    [key],
  );
  const r = rows[0];
  if (!r) return null;
  return r.result === null
    ? { kind: "existing", status: r.status, intentId: r.id }
    : { kind: "existing", status: r.status, result: r.result, intentId: r.id };
}

export async function reserveIntent(
  db: Db,
  claim: Claim,
  args: { stepIndex: number; toolCallIndex: number; reserveMicroUsd: number; budgetScopes: string[] },
): Promise<ReserveResult> {
  assertMicro("reserveMicroUsd", args.reserveMicroUsd);
  assertMicro("stepIndex", args.stepIndex);
  assertMicro("toolCallIndex", args.toolCallIndex);
  const scopes = normalizeScopes(args.budgetScopes);
  const key = callKey(claim.stageRunId, args.stepIndex, args.toolCallIndex);
  const amount = BigInt(args.reserveMicroUsd);

  return atomic(db, async (q): Promise<ReserveResult> => {
    // 1. Serialize on the budgets (sorted order => no deadlocks).
    const budgets = await lockBudgets(q, scopes);

    // 2. The claim must still be valid on the DB clock. FOR SHARE keeps the stage row from being
    //    requeued/refenced until this transaction ends, so the reservation cannot slip past a takeover.
    const { rows: live } = await q.query(
      `select 1 from stage_runs
        where id = $1 and status = 'running' and fence = $2 and lease_owner = $3
          and lease_until > clock_timestamp()
          for share`,
      [claim.stageRunId, claim.fence, claim.workerId],
    );
    if (live.length === 0) return { kind: "refused", reason: "stale_fence" };

    // 3. Replay of the same call: report what is there, reserve nothing.
    const already = await readExisting(q, key);
    if (already) return already;

    // 4. Cap check (fail closed on a missing budget row).
    for (const scope of scopes) {
      const b = budgets.get(scope);
      if (!b || b.reserved + b.spent + amount > b.cap) return { kind: "refused", reason: "cap" };
    }

    // 5. Insert; reserve only if WE inserted.
    const intentId = uuidv7();
    const ins = await q.query(
      `insert into spend_intents
         (id, stage_run_id, step_index, tool_call_index, call_key, status, reserved_micro_usd, fence, scopes)
       values ($1,$2,$3,$4,$5,'pending',$6,$7,$8)
       on conflict (call_key) do nothing
       returning id`,
      [intentId, claim.stageRunId, args.stepIndex, args.toolCallIndex, key, args.reserveMicroUsd, claim.fence, scopes],
    );
    if (ins.rowCount === 0) {
      const raced = await readExisting(q, key);
      if (!raced) throw new Error("spend intent vanished after a call_key conflict");
      return raced;
    }
    const upd = await q.query(
      "update budgets set reserved_micro_usd = reserved_micro_usd + $2 where scope = any($1::text[])",
      [scopes, args.reserveMicroUsd],
    );
    if (upd.rowCount !== scopes.length) throw new Error("budget rows changed during reservation");
    return { kind: "new", intentId };
  });
}

interface IntentRow {
  id: string;
  status: IntentStatus;
  reserved: string;
  actual: string | null;
  provider_ref: string | null;
  scopes: string[];
  same_result: boolean;
}

async function lockIntent(q: Q, intentId: string, resultJson: string): Promise<IntentRow> {
  const { rows } = await q.query<IntentRow>(
    `select id, status, reserved_micro_usd as reserved, actual_micro_usd as actual, provider_ref, scopes,
            (result is not distinct from $2::jsonb) as same_result
       from spend_intents where id = $1 for update`,
    [intentId, resultJson],
  );
  const r = rows[0];
  if (!r) throw new Error(`spend intent ${intentId} not found`);
  return r;
}

// Releases the reservation from every scope it was held against and optionally records spend.
async function moveBudgets(q: Q, row: IntentRow, spentMicroUsd: number): Promise<void> {
  const scopes = [...row.scopes].sort();
  await lockBudgets(q, scopes);
  const upd = await q.query(
    `update budgets
        set reserved_micro_usd = reserved_micro_usd - $2::bigint,
            spent_micro_usd = spent_micro_usd + $3::bigint
      where scope = any($1::text[])`,
    [scopes, row.reserved, spentMicroUsd],
  );
  if (upd.rowCount !== scopes.length) throw new Error("budget rows missing while releasing a reservation");
}

// Records money that was actually spent. Deliberately NOT gated on fence/lease: the provider charged us
// whether or not this worker still owns the stage. Idempotent: same values -> no-op; different -> throws.
export async function settleIntent(
  db: Db,
  intentId: string,
  args: { actualMicroUsd: number; result: unknown; providerRef?: string },
): Promise<{ overrun: boolean }> {
  assertMicro("actualMicroUsd", args.actualMicroUsd);
  const resultJson = JSON.stringify(args.result ?? null);
  const ref = args.providerRef ?? null;

  return atomic(db, async (q) => {
    const row = await lockIntent(q, intentId, resultJson);
    const reserved = toNumber(row.reserved);
    if (row.status === "done") {
      if (row.actual === null || toNumber(row.actual) !== args.actualMicroUsd || !row.same_result || row.provider_ref !== ref) {
        throw new Error(`spend intent ${intentId} already settled with different values`);
      }
      return { overrun: args.actualMicroUsd > reserved };
    }
    if (row.status !== "pending" && row.status !== "unknown") {
      throw new Error(`spend intent ${intentId} is ${row.status}; it cannot be settled`);
    }
    await moveBudgets(q, row, args.actualMicroUsd);
    await q.query(
      `update spend_intents
          set status = 'done', actual_micro_usd = $2, result = $3::jsonb, provider_ref = $4, updated_at = now()
        where id = $1`,
      [intentId, args.actualMicroUsd, resultJson, ref],
    );
    return { overrun: args.actualMicroUsd > reserved };
  });
}

// Provider said it failed and nothing was charged: pending -> failed_known, reservation released.
export async function failIntentKnown(db: Db, intentId: string, reason: string): Promise<boolean> {
  return atomic(db, async (q) => {
    const row = await lockIntent(q, intentId, "null");
    if (row.status !== "pending") return false;
    await moveBudgets(q, row, 0);
    await q.query(
      "update spend_intents set status = 'failed_known', result = $2::jsonb, updated_at = now() where id = $1",
      [intentId, JSON.stringify({ error: reason })],
    );
    return true;
  });
}

// Outcome unknown (money may have been spent): pending -> unknown, reservation stays held.
export async function markUnknown(db: Db, intentId: string): Promise<boolean> {
  return atomic(db, async (q) => {
    const row = await lockIntent(q, intentId, "null");
    if (row.status !== "pending") return false;
    await q.query("update spend_intents set status = 'unknown', updated_at = now() where id = $1", [intentId]);
    return true;
  });
}

export async function getBudget(db: Db, scope: string): Promise<Budget | null> {
  const { rows } = await db.query<{ cap: string; reserved: string; spent: string }>(
    `select cap_micro_usd as cap, reserved_micro_usd as reserved, spent_micro_usd as spent
       from budgets where scope = $1`,
    [scope],
  );
  const r = rows[0];
  if (!r) return null;
  return { scope, capMicroUsd: toNumber(r.cap), reservedMicroUsd: toNumber(r.reserved), spentMicroUsd: toNumber(r.spent) };
}
