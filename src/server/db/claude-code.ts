import type pg from "pg";
import { planAiSource, type Remembered } from "@/server/core/ai-source";
import { STAGES } from "@/server/core/llm-catalog";
import { recordAudit } from "@/server/db/audit";
import { CatalogError, createModel, listModels, listRoutes, localServices } from "@/server/db/llm-models";
import { getSetting, setSessionSettings, type Actor } from "@/server/db/settings";
import { createAiSdkStep } from "@/server/llm/ai-sdk-step";
import { createClaudeCodeModel, type ClaudeCodeDeps, type ClaudeCodeGate, type ClaudeCodeOutcome, type ClaudeCodeResult } from "@/server/llm/claude-code";

// The Claude Code switch, daily cap, last-call status, Test connection and the "AI source" switch (ADR 0014).

export async function claudeCodeEnabled(db: pg.Pool | pg.PoolClient): Promise<boolean> {
  return (await getSetting(db, "claude_code.enabled")) === true;
}

/** Counts one call against today's (UTC) cap in one statement; false, with nothing counted, when the cap is reached. */
export async function takeClaudeCodeSlot(db: pg.Pool | pg.PoolClient): Promise<boolean> {
  const cap = await getSetting(db, "claude_code.daily_cap");
  if (typeof cap !== "number" || !Number.isInteger(cap) || cap < 1) return false;
  const { rowCount } = await db.query(
    `insert into claude_code_daily_calls as d (day, calls) values ((now() at time zone 'utc')::date, 1)
     on conflict (day) do update set calls = d.calls + 1 where d.calls < $1
     returning calls`,
    [cap],
  );
  return rowCount === 1;
}

export async function claudeCodeUsedToday(db: pg.Pool | pg.PoolClient): Promise<number> {
  const { rows } = await db.query<{ calls: number }>("select calls from claude_code_daily_calls where day = (now() at time zone 'utc')::date");
  return rows[0]?.calls ?? 0;
}

/** Stores the outcome class of the last finished call (one row; never text). */
export async function recordClaudeCodeOutcome(db: pg.Pool | pg.PoolClient, o: ClaudeCodeOutcome): Promise<void> {
  await db.query("update claude_code_status set result = $1, auth = $2, result_at = clock_timestamp() where id", [o.result, o.auth ?? null]);
}

export function claudeCodeGate(db: pg.Pool): ClaudeCodeGate {
  return { enabled: () => claudeCodeEnabled(db), takeSlot: () => takeClaudeCodeSlot(db), record: (o) => recordClaudeCodeOutcome(db, o) };
}

export interface ClaudeCodeStatus {
  enabled: boolean;
  /** The AI source switch is on (setting ai.previous_routes holds the routes to restore). */
  switchOn: boolean;
  cap: number;
  usedToday: number;
  last: { result: ClaudeCodeResult; at: Date; auth: string | null } | null;
}

/** Read-only, for the Models page: never starts the program. */
export async function getClaudeCodeStatus(db: pg.Pool): Promise<ClaudeCodeStatus> {
  const [enabled, cap, prev, used, row] = await Promise.all([
    claudeCodeEnabled(db),
    getSetting(db, "claude_code.daily_cap"),
    getSetting(db, "ai.previous_routes"),
    claudeCodeUsedToday(db),
    db.query<{ result: ClaudeCodeResult | null; result_at: Date | null; auth: string | null }>("select result, result_at, auth from claude_code_status where id"),
  ]);
  const r = row.rows[0];
  return {
    enabled,
    switchOn: prev !== null && typeof prev === "object",
    cap: typeof cap === "number" ? cap : 0,
    usedToday: used,
    last: r?.result && r.result_at ? { result: r.result, at: r.result_at, auth: r.auth } : null,
  };
}

// ---------- Test connection ----------

const TEST_COOLDOWN_S = 10;
const TEST_TIMEOUT_MS = 30_000;
const TEST_SENTENCE: Record<ClaudeCodeResult, string> = {
  ready: "Passed: Claude Code answered.",
  not_found: "Failed: Claude Code is not installed or not on PATH.",
  not_logged_in: "Failed: Claude Code is not logged in. Run `claude` once and log in with your claude.ai subscription.",
  limit_reached: "Failed: the subscription usage limit is reached. Try again later.",
  failed: "Failed: Claude Code did not finish cleanly.",
};

/**
 * One tiny call ("reply with the word ok") through the SAME adapter a stage uses: same args, env, cwd, one-at-a-time
 * queue, and it counts toward the daily cap. Refused when switched off, over the cap, or tested in the last 10 s
 * (claimed atomically). The result is a fixed sentence per outcome class: never stdout, stderr or the answer.
 * `over` is for tests (a fake spawn); production passes nothing.
 */
export async function testClaudeCodeConnection(
  db: pg.Pool,
  actor: { kind: string },
  over: Partial<Omit<ClaudeCodeDeps, "gate">> = {},
): Promise<{ ok: boolean; message: string }> {
  if (actor?.kind !== "session") throw new CatalogError("Only a signed-in session can test Claude Code.");
  if (!(await claudeCodeEnabled(db))) throw new CatalogError("Claude Code is switched off. Turn on the AI source switch first.");
  const cap = await getSetting(db, "claude_code.daily_cap");
  if (typeof cap !== "number" || (await claudeCodeUsedToday(db)) >= cap) throw new CatalogError("The daily Claude Code cap is reached. It resets at midnight UTC.");
  const claimed = await db.query(
    `update claude_code_status set test_at = clock_timestamp()
      where id and (test_at is null or test_at <= clock_timestamp() - make_interval(secs => $1))`,
    [TEST_COOLDOWN_S],
  );
  if (claimed.rowCount !== 1) throw new CatalogError("Claude Code was tested a moment ago. Try again in a few seconds.");

  let outcome: ClaudeCodeOutcome | undefined;
  const base = claudeCodeGate(db);
  const gate: ClaudeCodeGate = { ...base, record: async (o) => { outcome = o; await base.record!(o); } };
  const step = createAiSdkStep(createClaudeCodeModel("default", { timeoutMs: TEST_TIMEOUT_MS, ...over, gate }), [], 16);
  try {
    await step([{ role: "user", content: "Reply with the word ok and nothing else." }], "claude-code-test", new AbortController().signal);
  } catch {
    // the class comes from the recorded outcome below
  }
  await recordAudit(db, "claude_code.tested", { result: outcome?.result ?? "not_started" });
  if (!outcome) return { ok: false, message: "Claude Code was not started (switched off or the daily cap was reached meanwhile)." };
  return { ok: outcome.result === "ready", message: TEST_SENTENCE[outcome.result] };
}

// ---------- the AI source switch ----------

/** The owner's enabled Claude Code model, copied from the suggestion (enabled) when there is none at all. */
async function claudeCodeModelId(db: pg.Pool, actor: Actor): Promise<string> {
  const mine = (await listModels(db)).filter((m) => m.provider === "claude_code");
  const usable = mine.find((m) => m.enabled);
  if (usable) return usable.id;
  if (mine.length > 0) throw new CatalogError("Your Claude Code model is disabled in the catalog. Enable it first.");
  const { rows } = await db.query("select model_id, label, capabilities from model_catalog_defaults where provider = 'claude_code' order by id limit 1");
  if (!rows[0]) throw new CatalogError("There is no Claude Code suggestion to copy. Add a Claude Code model first.");
  const m = await createModel(
    db,
    { provider: "claude_code", modelId: rows[0].model_id, label: rows[0].label, baseUrl: null, prices: null, isFree: true, capabilities: rows[0].capabilities, enabled: true },
    { actor },
  );
  return m.id;
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sorted = (r: Record<string, string>) => Object.fromEntries(Object.entries(r).sort(([a], [b]) => (a < b ? -1 : 1)));

/**
 * Turns the switch on or off (session only). ON: the text stages Claude Code can do are routed to it, the routes they had
 * are remembered (ai.previous_routes) and claude_code.enabled = true. OFF: the remembered routes come back stage by stage
 * and claude_code.enabled = false. Routes, both settings and one audit row (old -> new routes) change in ONE transaction;
 * if the routes or the remembered set changed since they were read, nothing changes. Returns the plain notes.
 */
export async function setAiSource(db: pg.Pool, on: boolean, opts: { actor: Actor }): Promise<string[]> {
  if (opts.actor !== "session") throw new CatalogError("Only a signed-in session can change the AI source.");
  const claudeCodeId = on ? await claudeCodeModelId(db, opts.actor) : undefined;
  const [routes, models, local, prevRaw] = await Promise.all([listRoutes(db), listModels(db), localServices(db), getSetting(db, "ai.previous_routes")]);
  const previous = (prevRaw ?? null) as Remembered | null;
  const plan = planAiSource({ on, routes, models, local, previous, ...(claudeCodeId !== undefined && { claudeCodeId }) });
  if (!plan.ok) throw new CatalogError(plan.reason);

  await setSessionSettings(
    db,
    [
      {
        key: "ai.previous_routes",
        value: (current: unknown) => {
          if (!sameJson(current ?? null, previous)) throw new CatalogError("The switch was changed at the same time. Reload and try again.");
          return plan.previous;
        },
      },
      { key: "claude_code.enabled", value: on },
    ],
    async (c, key) => {
      if (key !== "ai.previous_routes") return;
      const { rows } = await c.query<{ stage: string; model_id: string }>("select stage, model_id from llm_routes for update");
      if (!sameJson(sorted(Object.fromEntries(rows.map((r) => [r.stage, r.model_id]))), sorted(routes))) {
        throw new CatalogError("A route changed at the same time. Reload and try again.");
      }
      const from: Record<string, string | null> = {};
      const to: Record<string, string | null> = {};
      for (const s of STAGES) {
        const before = routes[s.id] ?? null;
        const after = plan.routes[s.id] ?? null;
        if (before === after) continue;
        from[s.id] = before;
        to[s.id] = after;
        if (after === null) await c.query("delete from llm_routes where stage = $1", [s.id]);
        else
          await c.query(
            `insert into llm_routes (stage, model_id, updated_at) values ($1, $2, now())
             on conflict (stage) do update set model_id = excluded.model_id, updated_at = now()`,
            [s.id, after],
          );
      }
      await recordAudit(c, "ai_source.changed", { source: on ? "claude_code" : "api", from, to });
    },
  );
  return plan.notes;
}
