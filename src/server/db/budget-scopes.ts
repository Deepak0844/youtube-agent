import type pg from "pg";

// Budget scopes that limit one run, one video, one UTC day or one UTC month. The seeded rows (`draft_run`, `video:<kind>`,
// `day`, `month`, ...) are TEMPLATES: each scope below is a copy with the template's cap. Every stage that reserves money
// must get its scopes from here (not use the template rows directly: they would add up forever).
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

/** `day:<date>` and `month:<yyyy-mm>` copies of the seeded `day` and `month` caps. */
export async function periodScopes(db: pg.Pool): Promise<[string, string][]> {
  const { day, month } = await utcPeriods(db);
  return [[`day:${day}`, "day"], [`month:${month}`, "month"]];
}
