import { describe, expect, it } from "vitest";
import { checkEvidence, foldForQuote } from "@/server/authoring/draft/evidence-check";
import type { Script } from "@/server/core/script-contract";

const page = "The octopus has  three hearts.\nTwo pump blood to the GILLS; one serves the body.";
const url = "https://a.test/octopus";
const script = (evidence: Script["evidence"]): Script => ({ narration: "n", beats: [{ id: "b1" }], title: "t", evidence });
const sourced = (source_url: string, quote: string) => ({ text: "Two hearts pump blood to the gills", kind: "sourced" as const, source_url, quote });

describe("checkEvidence", () => {
  it("accepts_a_quote_that_appears_after_case_whitespace_and_unicode_folding", () => {
    const r = checkEvidence(script([sourced(url, "THREE hearts. two pump blood to the gills"), sourced(url, "ＯＣＴＯＰＵＳ has three hearts. two pump blood")]), new Map([[url, page]]));
    expect(r).toEqual({ ok: true });
  });
  it("rejects_a_quote_not_on_the_fetched_page", () => {
    const r = checkEvidence(script([sourced(url, "octopuses have nine brains and a beak")]), new Map([[url, page]]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems[0]).toMatch(/claim 1.*quote.*not.*page/i);
  });
  it("rejects_a_source_url_that_was_never_fetched", () => {
    const r = checkEvidence(script([sourced("https://evil.test/x", "three hearts")]), new Map([[url, page]]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems[0]).toMatch(/claim 1.*not.*fetched/i);
  });
  it("computed_claims_need_no_page_and_an_empty_fetch_set_is_fine_for_them", () => {
    expect(checkEvidence(script([{ text: "2+2", kind: "computed", method: "add" }]), new Map())).toEqual({ ok: true });
  });
  it("a_quote_that_folds_to_nothing_is_rejected", () => {
    expect(checkEvidence(script([sourced(url, " ​ ")]), new Map([[url, page]])).ok).toBe(false);
  });
  it("problems_never_echo_model_text_and_list_every_bad_claim", () => {
    const r = checkEvidence(script([sourced(url, "SECRET-MODEL-TEXT"), sourced("https://x.test/", "q")]), new Map([[url, page]]));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.problems).toHaveLength(2);
      expect(r.problems.join(" ")).not.toContain("SECRET-MODEL-TEXT");
    }
  });
  it("tiny_quotes_are_rejected_even_when_they_appear_on_the_page", () => {
    for (const q of ["e", "the", "three hearts", "octopus has three hearts"]) {
      const r = checkEvidence(script([sourced(url, q)]), new Map([[url, page]]));
      expect(r.ok, q).toBe(false);
      if (!r.ok) expect(r.problems[0]).toMatch(/claim 1.*too short/);
    }
  });
  it("a_quote_that_shares_nothing_with_the_claim_is_rejected_but_other_scripts_are_not_compared", () => {
    const off = { text: "Gold melts at 1064 degrees", kind: "sourced" as const, source_url: url, quote: "Two pump blood to the gills" };
    const r = checkEvidence(script([off]), new Map([[url, page]]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems[0]).toMatch(/claim 1.*does not support/);
    const hiPage = "यह एक बहुत लंबा वाक्य है जो यहाँ लिखा गया है";
    expect(checkEvidence(script([{ ...off, quote: hiPage }]), new Map([[url, hiPage]]))).toEqual({ ok: true });
  });
  it("fold_is_nfkc_whitespace_and_case", () => {
    expect(foldForQuote("  Ａ\tb\n\nC ")).toBe("a b c");
  });
});
