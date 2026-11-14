import { describe, expect, it } from "vitest";
import { FX_SOURCES, fxRefreshDue, parseFxAnswer, rateInRange } from "@/server/core/fx-rate";

// The USD to INR display rate, fetched once a day from a free public rate service (no AI, no account, no browser). The parsers
// accept only the documented shapes; a missing or odd number is refused, never guessed.

describe("parseFxAnswer", () => {
  it("reads_frankfurter_and_open_er_api", () => {
    expect(parseFxAnswer("frankfurter", JSON.stringify({ amount: 1, base: "USD", date: "2026-11-13", rates: { INR: 94.25 } }))).toEqual({ rate: 94.25, rateDate: "2026-11-13" });
    expect(parseFxAnswer("open-er-api", JSON.stringify({ result: "success", base_code: "USD", time_last_update_utc: "Sat, 14 Nov 2026 00:02:31 +0000", rates: { INR: 94.289707 } }))).toEqual({ rate: 94.2897, rateDate: "2026-11-14" });
  });

  it("refuses_anything_else", () => {
    const bad = [
      "not json", "{}", "[]", "null",
      JSON.stringify({ base: "EUR", date: "2026-11-13", rates: { INR: 94.25 } }), // wrong base
      JSON.stringify({ base: "USD", date: "2026-11-13", rates: { INR: "94.25" } }), // a string, not a number
      JSON.stringify({ base: "USD", date: "2026-11-13", rates: { INR: -3 } }),
      JSON.stringify({ base: "USD", date: "2026-11-13", rates: {} }),
      JSON.stringify({ base: "USD", date: "yesterday", rates: { INR: 94.25 } }),
    ];
    for (const b of bad) expect(parseFxAnswer("frankfurter", b), b).toBeNull();
    expect(parseFxAnswer("open-er-api", JSON.stringify({ result: "error", base_code: "USD", rates: { INR: 94 } }))).toBeNull();
    expect(parseFxAnswer("open-er-api", JSON.stringify({ result: "success", base_code: "GBP", rates: { INR: 94 } }))).toBeNull();
  });
});

describe("rateInRange", () => {
  it("accepts_only_believable_rupee_rates", () => {
    for (const ok of [60, 94.25, 150]) expect(rateInRange(ok), String(ok)).toBe(true);
    for (const bad of [0, -1, 1, 9.4, 949.5, 10_000, NaN, Infinity]) expect(rateInRange(bad), String(bad)).toBe(false);
  });
});

describe("fxRefreshDue", () => {
  const at = (iso: string) => new Date(iso);
  it("is_due_from_9_in_the_morning_IST_once_a_day", () => {
    const meta = (fetchedAt: string) => ({ source: "frankfurter", rateDate: "2026-11-13", fetchedAt });
    expect(fxRefreshDue(at("2026-11-14T02:00:00Z"), null, true)).toBe(false); // 07:30 IST: too early
    expect(fxRefreshDue(at("2026-11-14T03:30:00Z"), null, true)).toBe(true); // 09:00 IST, never fetched
    expect(fxRefreshDue(at("2026-11-14T10:00:00Z"), meta("2026-11-14T04:00:00Z"), true)).toBe(false); // already fetched today (IST)
    expect(fxRefreshDue(at("2026-11-14T10:00:00Z"), meta("2026-11-13T05:00:00Z"), true)).toBe(true); // fetched yesterday
    expect(fxRefreshDue(at("2026-11-14T20:00:00Z"), meta("2026-11-14T10:00:00Z"), true)).toBe(false); // 01:30 IST next day: new day, but too early
    expect(fxRefreshDue(at("2026-11-15T04:00:00Z"), meta("2026-11-14T10:00:00Z"), true)).toBe(true); // 09:30 IST next day: due again
    expect(fxRefreshDue(at("2026-11-14T10:00:00Z"), null, false)).toBe(false); // the owner turned it off
  });
});

describe("FX_SOURCES", () => {
  it("names_exactly_two_https_hosts_and_the_credit_line", () => {
    expect(FX_SOURCES.map((s) => new URL(s.url).host)).toEqual(["api.frankfurter.dev", "open.er-api.com"]);
    for (const s of FX_SOURCES) {
      expect(new URL(s.url).protocol).toBe("https:");
      expect(s.credit.length).toBeGreaterThan(10);
    }
  });
});

describe("readCapped", () => {
  it("reads_a_small_body_and_stops_at_the_cap_without_reading_the_rest", async () => {
    const { readCapped } = await import("@/server/db/fx-rate");
    expect(await readCapped(new Response("hello"), 100)).toBe("hello");
    let pulled = 0;
    const endless = new Response(new ReadableStream({ pull(c) { pulled++; c.enqueue(new TextEncoder().encode("x".repeat(10_000))); } }));
    const text = await readCapped(endless, 25_000);
    expect(text.length).toBeGreaterThan(25_000); // one over the cap: the caller refuses it
    expect(text.length).toBeLessThanOrEqual(30_000);
    expect(pulled).toBeLessThan(10); // never read the whole (endless) body
  });
});

describe("fxNote", () => {
  it("says_where_which_rate_date_and_when_in_IST", async () => {
    const { fxNote } = await import("@/server/core/fx-rate");
    expect(fxNote({ source: "frankfurter", rateDate: "2026-11-13", fetchedAt: "2026-11-14T05:00:00.000Z" })).toBe("From Frankfurter (European Central Bank daily rates), rate of 2026-11-13, fetched 2026-11-14 10:30 IST.");
    expect(fxNote({ source: "other", rateDate: "2026-11-13", fetchedAt: "garbage" })).toBe("From other, rate of 2026-11-13.");
  });
});
