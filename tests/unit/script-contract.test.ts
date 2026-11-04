import { describe, expect, it } from "vitest";
import { validateScript } from "@/server/core/script-contract";
import { wordRange, type Lang } from "@/server/core/lang";

const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
const good = (narration = words(100)) => ({
  narration,
  beats: [{ id: "hook" }],
  title: "T",
  evidence: [{ text: "c", kind: "sourced", source_url: "https://example.com/a", quote: "q" }],
});
const problems = (r: ReturnType<typeof validateScript>) => (r.ok ? [] : r.problems);

describe("validateScript", () => {
  it("accepts a good short", () => expect(validateScript(good(), "en", "short").ok).toBe(true));
  it("cta_outro_is_rejected", () => {
    const r = validateScript(good(words(100) + " subscribe for more"), "en", "short");
    expect(problems(r).join()).toMatch(/CTA/);
  });
  it.each(["en", "hi", "ta", "te", "ml", "kn"] as Lang[])("too_short_narration_is_rejected %s", (l) => {
    expect(problems(validateScript(good(words(wordRange(l).min - 1)), l, "short")).join()).toMatch(/spoken words/);
    expect(problems(validateScript(good(words(wordRange(l).max + 1)), l, "short")).join()).toMatch(/spoken words/);
    expect(validateScript(good(words(wordRange(l).min)), l, "short").ok).toBe(true);
  });
  it("empty evidence rejected only when required", () => {
    const s = { ...good(), evidence: [] };
    expect(validateScript(s, "en", "short").ok).toBe(false);
    expect(validateScript(s, "en", "short", { requireEvidence: false }).ok).toBe(true);
  });
  it("verified_by_from_the_model_is_stripped", () => {
    const s = good();
    const dirty = { ...s, verified: true, evidence: [{ ...s.evidence[0], verified_by: "model" }], beats: [{ id: "a", verified_by: "x" }] };
    const r = validateScript(dirty, "en", "short");
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r.ok && r.script)).not.toMatch(/verified/);
  });
  it("javascript_url_in_evidence_is_rejected", () => {
    for (const u of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "nope"]) {
      const s = good();
      s.evidence[0]!.source_url = u;
      expect(validateScript(s, "en", "short").ok, u).toBe(false);
    }
  });
  it("computed claims need a method", () => {
    const s = { ...good(), evidence: [{ text: "c", kind: "computed", method: "sum" }] };
    expect(validateScript(s, "en", "short").ok).toBe(true);
    expect(validateScript({ ...s, evidence: [{ text: "c", kind: "computed" }] }, "en", "short").ok).toBe(false);
  });
  it("rejects NUL, oversize bodies and non-objects", () => {
    expect(problems(validateScript({ ...good(), title: "a\u0000b" }, "en", "short")).join()).toMatch(/NUL/);
    expect(problems(validateScript({ ...good(), description: "x".repeat(300_000) }, "en", "short")).join()).toMatch(/256 KB/);
    expect(validateScript(null, "en", "short").ok).toBe(false);
    expect(validateScript(undefined, "en", "short").ok).toBe(false);
  });
  it("old_beats_and_new_visual_and_shown_for_real_validate", () => {
    expect(validateScript(good(), "en", "short").ok).toBe(true);
    const r = validateScript({ ...good(), shown_for_real: "real binary search steps", beats: [{ id: "hook", visual: "x".repeat(320) }] }, "en", "short");
    expect(r.ok && r.script.shown_for_real).toBe("real binary search steps");
    expect(validateScript({ ...good(), beats: [{ id: "hook", visual: "x".repeat(321) }] }, "en", "short").ok).toBe(false);
    expect(validateScript({ ...good(), shown_for_real: "x".repeat(201) }, "en", "short").ok).toBe(false);
  });
});

describe("validateScript, scale3d", () => {
  const item = (over: Record<string, unknown> = {}) => ({ label: "Tower crane", kind: "tower_crane", height_m: 80, source_url: "https://example.com/c", quote: "a tower crane is about 80 m tall", ...over });
  const s3 = (scale: unknown) => ({ ...good(), evidence: [], scale });
  const run = (scale: unknown, requireEvidence = true) => validateScript(s3(scale), "en", "short", { kind: "scale3d", requireEvidence });
  it("turns_each_height_into_an_evidence_claim", () => {
    const r = run([item(), item({ label: "Person", kind: "person", height_m: 1.8, source_url: undefined, quote: undefined, method: "average adult" })]);
    if (!r.ok) throw new Error(r.problems.join());
    expect(r.script.evidence).toEqual([
      { text: "Tower crane is about 80 m tall", kind: "sourced", source_url: "https://example.com/c", quote: "a tower crane is about 80 m tall" },
      { text: "Person is about 1.8 m tall", kind: "computed", method: "average adult" },
    ]);
    expect(r.script.scale).toHaveLength(2);
  });
  it("needs_a_scale_list_of_two_or_more", () => {
    expect(problems(validateScript(good(), "en", "short", { kind: "scale3d" })).join()).toMatch(/scale list/);
    expect(problems(run([item()])).join()).toMatch(/at least 2/);
  });
  it("rejects_unknown_kinds_impossible_heights_and_too_many_objects", () => {
    expect(run([item(), item({ label: "Dragon", kind: "dragon" })]).ok).toBe(false);
    expect(problems(run([item(), item({ label: "Giant", kind: "person", height_m: 40 })])).join()).toMatch(/person cannot be 40 m/);
    expect(run([item(), item({ label: "Zero", height_m: 0 })]).ok).toBe(false);
    expect(run(Array.from({ length: 13 }, (_, i) => item({ label: `Crane ${i}` }))).ok).toBe(false);
    expect(run(Array.from({ length: 12 }, (_, i) => item({ label: `Crane ${i}` }))).ok).toBe(true);
  });
  it("a_height_with_no_source_or_method_is_rejected", () => {
    expect(problems(run([item(), item({ label: "Bare", source_url: undefined, quote: undefined })])).join()).toMatch(/source_url with a quote, or a method/);
  });
  it("scale_is_refused_on_other_kinds", () => {
    expect(problems(validateScript({ ...good(), scale: [item(), item({ label: "B" })] }, "en", "short", { kind: "scene_kit" })).join()).toMatch(/only for 3D/);
  });
});
