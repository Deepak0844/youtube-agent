import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type FxFetcher, refreshInrRate, throttledFxRate } from "@/server/db/fx-rate";
import { loadInrAuto, saveInrAuto } from "@/server/db/system-settings";
import { listAudit } from "@/server/db/audit";
import { getSetting, setSetting } from "@/server/db/settings";
import { withTestDb, type TestDb } from "../support/db";

// The daily rupee rate refresh against a real database and a fake rate service. The real service is never called here.

let db: TestDb;
beforeAll(async () => {
  db = await withTestDb();
});
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
});

const FRANKFURTER = (inr: unknown) => JSON.stringify({ amount: 1, base: "USD", date: "2026-11-13", rates: { INR: inr } });
const OPEN_ER = (inr: unknown) => JSON.stringify({ result: "success", base_code: "USD", time_last_update_utc: "Sat, 14 Nov 2026 00:02:31 +0000", rates: { INR: inr } });
/** A fake: answers per host; records the URLs asked. */
const fake = (answers: Record<string, { status?: number; text?: string; throws?: boolean }>) => {
  const asked: string[] = [];
  const fetcher: FxFetcher = async (url) => {
    asked.push(url);
    const a = answers[new URL(url).host];
    if (!a || a.throws) throw new Error("network down");
    return { status: a.status ?? 200, text: a.text ?? "" };
  };
  return { fetcher, asked };
};
const NOW = new Date("2026-11-14T05:00:00Z"); // 10:30 IST

describe("refreshInrRate", () => {
  it("fetches_the_rate_saves_it_with_its_source_and_audits_the_change", async () => {
    const f = fake({ "api.frankfurter.dev": { text: FRANKFURTER(94.25) } });
    expect(await refreshInrRate(db.pool, f.fetcher, NOW)).toEqual({ ok: true, rate: 94.25, source: "frankfurter", rateDate: "2026-11-13" });
    expect(await getSetting(db.pool, "display.inr_rate")).toBe(94.25);
    expect(await getSetting(db.pool, "display.inr_meta")).toEqual({ source: "frankfurter", rateDate: "2026-11-13", fetchedAt: NOW.toISOString() });
    expect(f.asked).toEqual(["https://api.frankfurter.dev/v1/latest?base=USD&symbols=INR"]); // the backup was not needed
    const audit = (await listAudit(db.pool, { eventPrefix: "setting.changed" })).rows.map((r) => r.detail as { setting: string; from: unknown; to: unknown });
    expect(audit.find((d) => d.setting === "display.inr_rate")).toMatchObject({ from: 95.05, to: 94.25 });
  });

  it("falls_back_to_the_second_service_when_the_first_is_down_or_odd", async () => {
    for (const first of [{ throws: true }, { status: 503, text: "" }, { text: "<html>captcha</html>" }, { text: FRANKFURTER("94") }, { text: FRANKFURTER(9.4) }]) {
      await db.reset();
      const f = fake({ "api.frankfurter.dev": first, "open.er-api.com": { text: OPEN_ER(94.289707) } });
      expect(await refreshInrRate(db.pool, f.fetcher, NOW), JSON.stringify(first)).toEqual({ ok: true, rate: 94.2897, source: "open-er-api", rateDate: "2026-11-14" });
      expect(f.asked.length).toBe(2);
    }
  });

  it("keeps_the_last_good_rate_when_both_fail_and_says_why", async () => {
    await setSetting(db.pool, "display.inr_rate", 93.5, { actor: "system" });
    const r = await refreshInrRate(db.pool, fake({ "api.frankfurter.dev": { throws: true }, "open.er-api.com": { text: OPEN_ER(1000) } }).fetcher, NOW);
    expect(r).toEqual({ ok: false, error: "No rate service gave a usable answer. The last rate is kept." });
    expect(await getSetting(db.pool, "display.inr_rate")).toBe(93.5);
    expect(await getSetting(db.pool, "display.inr_meta")).toBeNull();
  });

  it("an_oversized_answer_is_refused", async () => {
    const r = await refreshInrRate(db.pool, fake({ "api.frankfurter.dev": { text: FRANKFURTER(94.25) + " ".repeat(40_000) }, "open.er-api.com": { throws: true } }).fetcher, NOW);
    expect(r.ok).toBe(false);
  });
});

describe("throttledFxRate (the worker's daily job)", () => {
  it("runs_once_a_day_from_9_IST_only_when_automatic", async () => {
    const f = fake({ "api.frankfurter.dev": { text: FRANKFURTER(94.25) } });
    let clock = new Date("2026-11-14T02:00:00Z").getTime(); // 07:30 IST
    const tick = throttledFxRate(db.pool, { fetcher: f.fetcher, now: () => clock, everyMs: 0 });
    await tick();
    expect(f.asked).toHaveLength(0); // too early
    clock = new Date("2026-11-14T04:00:00Z").getTime(); // 09:30 IST
    await tick();
    expect(f.asked).toHaveLength(1);
    clock += 3_600_000;
    await tick();
    expect(f.asked).toHaveLength(1); // already fetched today
    clock = new Date("2026-11-15T04:00:00Z").getTime();
    await setSetting(db.pool, "display.inr_auto", false, { actor: "session" });
    await tick();
    expect(f.asked).toHaveLength(1); // the owner turned it off
    await setSetting(db.pool, "display.inr_auto", true, { actor: "session" });
    await tick();
    expect(f.asked).toHaveLength(2); // a new day
  });

  it("a_failed_day_is_retried_only_after_an_hour_and_never_throws", async () => {
    const f = fake({ "api.frankfurter.dev": { throws: true }, "open.er-api.com": { throws: true } });
    let clock = new Date("2026-11-14T04:00:00Z").getTime();
    const tick = throttledFxRate(db.pool, { fetcher: f.fetcher, now: () => clock, everyMs: 0 });
    await tick();
    expect(f.asked).toHaveLength(2);
    clock += 30 * 60_000;
    await tick();
    expect(f.asked).toHaveLength(2); // too soon after the failure
    clock += 31 * 60_000;
    await tick();
    expect(f.asked).toHaveLength(4);
  });
});

describe("the automatic switch and the card's facts", () => {
  it("is_on_by_default_changes_only_as_a_session_and_is_audited", async () => {
    expect(await loadInrAuto(db.pool)).toEqual({ auto: true, meta: null });
    expect(await saveInrAuto(db.pool, false)).toMatchObject({ ok: true });
    expect((await db.pool.query("select updated_by from settings where key = 'display.inr_auto'")).rows[0].updated_by).toBe("session");
    expect(await loadInrAuto(db.pool)).toEqual({ auto: false, meta: null });
    const audit = (await listAudit(db.pool, { eventPrefix: "setting.changed" })).rows.map((r) => r.detail as { setting: string; to: unknown });
    expect(audit.find((d) => d.setting === "display.inr_auto")).toMatchObject({ to: false });
  });

  it("reports_where_and_when_the_rate_came_from_once_fetched", async () => {
    await refreshInrRate(db.pool, fake({ "api.frankfurter.dev": { text: FRANKFURTER(94.25) } }).fetcher, NOW);
    expect(await loadInrAuto(db.pool)).toEqual({ auto: true, meta: { source: "frankfurter", rateDate: "2026-11-13", fetchedAt: NOW.toISOString() } });
  });
});
