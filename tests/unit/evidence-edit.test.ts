import { describe, expect, it } from "vitest";
import { claimsSha, evidenceVerificationProblem, evidenceVerified, parseClaims, seedClaims, sourceUrls } from "@/server/core/evidence-edit";

const sourced = { text: "Sky is blue", kind: "sourced", source_url: "https://example.com/a", quote: "blue" };
const computed = { text: "2+2", kind: "computed", method: "add" };

describe("parseClaims", () => {
  it("accepts both kinds", () => {
    expect(parseClaims([sourced, computed]).ok).toBe(true);
  });
  it("explains what is missing in plain words", () => {
    const r = parseClaims([{ ...sourced, source_url: "ftp://x" }, { ...computed, method: "" }]);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.problems.join(" ")).toMatch(/claim 1.*http/);
    expect(!r.ok && r.problems.join(" ")).toMatch(/claim 2.*computed/);
  });
  it("refuses a non-list and too many claims", () => {
    expect(parseClaims("x").ok).toBe(false);
    expect(parseClaims(Array.from({ length: 41 }, () => computed)).ok).toBe(false);
  });
});

describe("evidenceVerified", () => {
  const claims = [sourced];
  const good = { claims, verification: { at: "t", by: "owner", ok: true, claims_sha: claimsSha(parseClaimsOk(claims)), problems: [], results: [] } };
  function parseClaimsOk(c: unknown[]) {
    const r = parseClaims(c);
    if (!r.ok) throw new Error("bad");
    return r.claims;
  }
  it("is true only for an ok owner verification made for these claims", () => {
    expect(evidenceVerified(good)).toBe(true);
    expect(evidenceVerified({ ...good, claims: [sourced, computed] })).toBe(false); // edited after verifying
    expect(evidenceVerified({ ...good, verification: { ...good.verification, ok: false } })).toBe(false);
    expect(evidenceVerified({ ...good, verification: { ...good.verification, by: "agent" } })).toBe(false);
    expect(evidenceVerified({ claims })).toBe(false);
    expect(evidenceVerified({ claims: [], verification: { ...good.verification } })).toBe(false);
    expect(evidenceVerified(null)).toBe(false);
  });
  it("only an explicit false switches the publish check off; file-only bodies are not claim based", () => {
    expect(evidenceVerificationProblem(true, { claims })).toMatch(/verified/);
    expect(evidenceVerificationProblem(undefined, { claims })).toMatch(/verified/);
    expect(evidenceVerificationProblem(false, { claims })).toBeNull();
    expect(evidenceVerificationProblem(true, good)).toBeNull();
    expect(evidenceVerificationProblem(true, null)).toBeNull();
  });
});

describe("seedClaims / sourceUrls", () => {
  it("uses the script's claims, else one empty computed claim per sentence with a number", () => {
    expect(seedClaims({ evidence: [computed], narration: "x 1." })).toEqual([computed]);
    const s = seedClaims({ evidence: [], narration: "Light is fast. It moves 300000 km each second. Wow! Then 2 things." });
    expect(s.map((c) => c.text)).toEqual(["It moves 300000 km each second.", "Then 2 things."]);
    expect(s.every((c) => c.kind === "computed" && c.method === "")).toBe(true);
  });
  it("lists each source once", () => {
    const r = parseClaims([sourced, sourced, computed]);
    expect(r.ok && sourceUrls(r.claims)).toEqual(["https://example.com/a"]);
  });
});
