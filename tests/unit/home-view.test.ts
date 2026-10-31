import { describe, expect, it } from "vitest";
import { activityText, agoLabel, attentionKind, attentionText, mergeActivity, sortAttention, spendSentence, stageLabel } from "@/server/core/home-view";

const d = (s: string) => new Date(s);
const usd = (m: number) => `$${(m / 1e6).toFixed(2)}`;

describe("home view words", () => {
  it("agoLabel steps", () => {
    const now = d("2026-01-01T12:00:00Z").getTime();
    expect(agoLabel(d("2026-01-01T11:59:40Z"), now)).toBe("just now");
    expect(agoLabel(d("2026-01-01T11:55:00Z"), now)).toBe("5 min");
    expect(agoLabel(d("2026-01-01T09:00:00Z"), now)).toBe("3 h");
    expect(agoLabel("2025-12-28T12:00:00Z", now)).toBe("4 days");
    expect(agoLabel(d("2026-01-01T13:00:00Z"), now)).toBe("just now"); // future clock skew never goes negative
  });
  it("stage labels fall back to a plain word", () => {
    expect(stageLabel("render")).toBe("Rendering the video");
    expect(stageLabel("nope")).toBe("A step");
  });
  it("attention kind precedence", () => {
    expect(attentionKind({ upload: true, failed: false, budgetRefused: false, openIntent: false })).toBe("upload_failed");
    expect(attentionKind({ upload: false, failed: true, budgetRefused: false, openIntent: false })).toBe("failed_stage");
    expect(attentionKind({ upload: false, failed: false, budgetRefused: true, openIntent: true })).toBe("budget_held");
    expect(attentionKind({ upload: false, failed: false, budgetRefused: false, openIntent: true })).toBe("paid_unclear");
    expect(attentionKind({ upload: false, failed: false, budgetRefused: false, openIntent: false })).toBe("needs_decision");
  });
  it("attention sorts money questions first, then oldest first", () => {
    const rows = [
      { kind: "failed_stage" as const, at: d("2026-01-01") },
      { kind: "paid_unclear" as const, at: d("2026-01-03") },
      { kind: "paid_unclear" as const, at: d("2026-01-02") },
      { kind: "upload_failed" as const, at: d("2026-01-05") },
    ];
    expect(sortAttention(rows).map((r) => r.at.toISOString().slice(8, 10))).toEqual(["02", "03", "05", "01"]);
  });
  it("attention text names the step and the action", () => {
    expect(attentionText({ kind: "paid_unclear", stage: "generate" })).toMatchObject({ action: "Check the job or decide" });
    expect(attentionText({ kind: "failed_stage", stage: "render" }).text).toContain("rendering the video");
    expect(attentionText({ kind: "upload_failed", stage: null }).text).toContain("upload");
  });
  it("activity text uses the audit catalogue and plain event words", () => {
    expect(activityText({ at: d("2026-01-01"), source: "audit", type: "gate.approved", topic: null, stage: null, gate: null })).toBe("A gate was approved");
    expect(activityText({ at: d("2026-01-01"), source: "audit", type: "unknown.thing", topic: null, stage: null, gate: null })).toBe("Something changed in the studio");
    expect(activityText({ at: d("2026-01-01"), source: "event", type: "stage.failed", topic: "Why", stage: "tts", gate: null })).toBe('"Why": recording the voice failed');
    expect(activityText({ at: d("2026-01-01"), source: "event", type: "gate.waiting", topic: "Why", stage: null, gate: "script" })).toBe('"Why": script gate is waiting for you');
    expect(activityText({ at: d("2026-01-01"), source: "event", type: "video.done", topic: null, stage: null, gate: null })).toBe("A video is done");
  });
  it("mergeActivity is newest first and bounded", () => {
    const mk = (day: string) => ({ at: d(`2026-01-${day}`), source: "audit" as const, type: "key.set", topic: null, stage: null, gate: null });
    const out = mergeActivity([mk("01"), mk("03"), mk("02")], 2);
    expect(out.map((o) => o.at.toISOString().slice(8, 10))).toEqual(["03", "02"]);
    expect(mergeActivity([], 5)).toEqual([]);
  });
  it("spend sentence handles no limit", () => {
    expect(spendSentence({ spentMicroUsd: 4_200_000, capMicroUsd: 15_000_000 }, usd)).toBe("$4.20 of $15.00");
    expect(spendSentence({ spentMicroUsd: 0, capMicroUsd: null }, usd)).toBe("$0.00, no limit");
  });
});
