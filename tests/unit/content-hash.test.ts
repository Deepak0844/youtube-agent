import { describe, expect, it } from "vitest";
import { canonicalJson, gateHash, sha256Hex } from "@/server/core/content-hash";
import { GATES } from "@/server/core/gates";

describe("canonicalJson", () => {
  it("is_equal_for_key_order_changes_and_different_for_any_value_change", () => {
    expect(canonicalJson({ a: 1, b: { c: [1, 2], d: "x" } })).toBe(canonicalJson({ b: { d: "x", c: [1, 2] }, a: 1 }));
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
    expect(canonicalJson({ a: [1, 2] })).not.toBe(canonicalJson({ a: [2, 1] }));
    expect(canonicalJson({ a: 1, b: 2 })).toBe('{"a":1,"b":2}');
  });
  it("rejects_nan_undefined_functions_and_other_non_json", () => {
    for (const bad of [NaN, Infinity, undefined, () => 1, { a: undefined }, [undefined], 1n, Symbol("x")]) {
      expect(() => canonicalJson(bad)).toThrow();
    }
  });
  it("hash_of_indic_text_is_nfc_stable", () => {
    const nfc = "क्षé"; // क्ष + é
    const nfd = nfc.normalize("NFD");
    expect(nfd).not.toBe(nfc);
    expect(canonicalJson({ [nfd]: nfd })).toBe(canonicalJson({ [nfc]: nfc }));
    expect(sha256Hex(canonicalJson({ t: nfd }))).toBe(sha256Hex(canonicalJson({ t: nfc })));
  });
});

describe("sha256Hex", () => {
  it("matches_known_vector_for_strings_and_bytes", () => {
    const abc = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    expect(sha256Hex("abc")).toBe(abc);
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(abc);
  });
});

describe("gateHash", () => {
  it("gateHash_requires_exactly_the_covered_keys", () => {
    for (const g of GATES) {
      const parts = Object.fromEntries(g.hashCovers.map((k) => [k, `h-${k}`]));
      const h = gateHash(g.id, parts);
      expect(h).toMatch(/^[0-9a-f]{64}$/);
      expect(gateHash(g.id, { ...parts })).toBe(h);
      for (const k of g.hashCovers) {
        const missing = Object.fromEntries(Object.entries(parts).filter(([pk]) => pk !== k));
        expect(() => gateHash(g.id, missing)).toThrow(/missing/);
        expect(gateHash(g.id, { ...parts, [k]: "other" })).not.toBe(h);
      }
      expect(() => gateHash(g.id, { ...parts, extra: "x" })).toThrow(/extra/);
    }
  });
});
