import { describe, expect, it } from "vitest";
import { sample } from "@/ui/sample/data";
import {
  checkAll,
  dayTotal,
  formatUsd,
  gateQueue,
  monthTotal,
  videoCost,
} from "@/ui/sample/reconcile";

const RANGES: Record<string, RegExp> = {
  hi: /[ऀ-ॿ]/,
  ta: /[஀-௿]/,
  te: /[ఀ-౿]/,
  ml: /[ഀ-ൿ]/,
  kn: /[ಀ-೿]/,
  en: /^[\x20-\x7E]+$/,
};

describe("sample data reconciliation", () => {
  it("passes every built-in check", () => {
    expect(checkAll(sample)).toEqual([]);
  });

  it("per-video cost equals the sum of its ledger rows", () => {
    for (const v of sample.videos) {
      const rows = sample.ledger.filter((r) => r.videoId === v.id);
      expect(videoCost(sample, v.id)).toBe(rows.reduce((s, r) => s + r.microUsd, 0));
    }
    expect(sample.ledger.every((r) => sample.videos.some((v) => v.id === r.videoId))).toBe(true);
  });

  it("day and month totals equal the sum of rows and of displayed parts", () => {
    const day = sample.ledger.filter((r) => r.day === sample.today);
    expect(dayTotal(sample)).toBe(day.reduce((s, r) => s + r.microUsd, 0));
    expect(monthTotal(sample)).toBe(sample.ledger.reduce((s, r) => s + r.microUsd, 0));
    const cents = day.reduce((s, r) => s + Number(formatUsd(r.microUsd).slice(1)) * 100, 0);
    expect(formatUsd(dayTotal(sample))).toBe(`$${(Math.round(cents) / 100).toFixed(2)}`);
  });

  it("day cap is $15.00 and is not exceeded", () => {
    expect(sample.budget.dayCapMicroUsd).toBe(15_000_000);
    expect(formatUsd(sample.budget.dayCapMicroUsd)).toBe("$15.00");
    expect(dayTotal(sample)).toBeLessThanOrEqual(sample.budget.dayCapMicroUsd);
  });

  it("gate counts equal queue lengths and cover every held video", () => {
    for (const g of sample.gates) {
      expect(g.waiting).toBe(gateQueue(sample, g.name).length);
    }
    const held = sample.videos.filter((v) => v.gate !== null).length;
    expect(sample.gates.reduce((s, g) => s + g.waiting, 0)).toBe(held);
  });

  it("2 Google accounts with 3 channels, all videos on a known channel", () => {
    expect(sample.accounts).toHaveLength(2);
    expect(sample.channels).toHaveLength(3);
    for (const c of sample.channels) {
      expect(sample.accounts.some((a) => a.id === c.accountId)).toBe(true);
    }
    for (const v of sample.videos) {
      expect(sample.channels.some((c) => c.id === v.channelId)).toBe(true);
    }
  });

  it("covers all six languages and both formats", () => {
    expect(new Set(sample.videos.map((v) => v.lang))).toEqual(new Set(Object.keys(RANGES)));
    expect(new Set(sample.videos.map((v) => v.format))).toEqual(new Set(["short", "long"]));
  });

  it("every title uses its language's script", () => {
    for (const v of [...sample.videos, ...sample.ideas]) {
      expect(v.title, v.title).toMatch(RANGES[v.lang]!);
    }
  });

  it("has ideas and integer micro-USD everywhere", () => {
    expect(sample.ideas.length).toBeGreaterThan(0);
    for (const r of sample.ledger) expect(Number.isInteger(r.microUsd)).toBe(true);
  });
});
