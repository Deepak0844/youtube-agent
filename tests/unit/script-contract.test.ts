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
});
