import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_LIFETIME_SEC, resignIfNear, signMediaUrl, verifyMediaUrl } from "@/server/storage/sign";

const key = randomBytes(32);
const other = randomBytes(32);
const NOW = 1_800_000_000;
const parse = (url: string) => {
  const u = new URL(url, "http://x.test");
  return { pathname: u.pathname, e: u.searchParams.get("e"), s: u.searchParams.get("s") };
};
const check = (url: string, k = key, now = NOW) => {
  const p = parse(url);
  const rel = p.pathname.replace(/^\/api\/media\//, "").split("/").map(decodeURIComponent).join("/");
  return verifyMediaUrl({ path: rel, e: p.e, s: p.s }, k, now);
};

describe("signMediaUrl", () => {
  it("round_trips_and_has_the_documented_shape", () => {
    const url = signMediaUrl("videos/abc/final.mp4", NOW + 100, key);
    expect(url).toMatch(/^\/api\/media\/videos\/abc\/final\.mp4\?e=\d+&s=[A-Za-z0-9_-]{43}$/);
    expect(check(url)).toEqual({ ok: true, path: "videos/abc/final.mp4", exp: NOW + 100 });
  });
  it("encodes_unusual_but_legal_file_names", () => {
    const url = signMediaUrl("videos/a b/ü?#%.png", NOW + 100, key);
    const u = new URL(url, "http://x.test");
    expect(u.search.startsWith("?e=")).toBe(true); // ? and # in the name did not leak into the query
    expect(check(url).ok).toBe(true);
  });
  it("refuses_to_sign_a_bad_path_or_a_bad_expiry_or_a_short_key", () => {
    for (const p of ["../x", "/abs", "a//b", "a\0b", "", "a/./b"]) expect(() => signMediaUrl(p, NOW + 1, key), p).toThrow();
    for (const e of [Number.NaN, 1.5, -1, Infinity, 0]) expect(() => signMediaUrl("a/b.mp4", e, key), String(e)).toThrow();
    expect(() => signMediaUrl("a/b.mp4", NOW, randomBytes(16))).toThrow();
  });
});

describe("verifyMediaUrl", () => {
  const good = signMediaUrl("videos/abc/final.mp4", NOW + 100, key);
  it("tampered_path_exp_or_sig_is_refused", () => {
    const p = parse(good);
    const base = { path: "videos/abc/final.mp4", e: p.e, s: p.s };
    expect(verifyMediaUrl(base, key, NOW).ok).toBe(true);
    expect(verifyMediaUrl({ ...base, path: "videos/abc/other.mp4" }, key, NOW).ok).toBe(false);
    expect(verifyMediaUrl({ ...base, e: String(NOW + 101) }, key, NOW).ok).toBe(false);
    expect(verifyMediaUrl({ ...base, e: String(NOW + 99999) }, key, NOW).ok).toBe(false);
    const s = p.s!;
    expect(verifyMediaUrl({ ...base, s: (s[0] === "A" ? "B" : "A") + s.slice(1) }, key, NOW).ok).toBe(false);
    expect(verifyMediaUrl({ ...base, s: s.slice(0, -1) }, key, NOW).ok).toBe(false);
    expect(verifyMediaUrl({ ...base, s: s + "A" }, key, NOW).ok).toBe(false);
    expect(verifyMediaUrl(base, other, NOW).ok).toBe(false);
  });
  it("malformed_or_missing_query_values_are_refused", () => {
    const p = parse(good);
    const path = "videos/abc/final.mp4";
    for (const e of [null, "", "abc", "-5", "1e9", "0x10", "1.5", " 1800000100", "01800000100", "9".repeat(20), String(NOW + 100) + "\0"]) {
      expect(verifyMediaUrl({ path, e, s: p.s }, key, NOW).ok, String(e)).toBe(false);
    }
    for (const s of [null, "", "***", "A".repeat(100), p.s + "="]) expect(verifyMediaUrl({ path, e: p.e, s }, key, NOW).ok, String(s)).toBe(false);
  });
  it("expired_url_is_refused_at_and_after_the_boundary_second", () => {
    const url = signMediaUrl("videos/abc/final.mp4", NOW + 100, key);
    expect(check(url, key, NOW + 99).ok).toBe(true);
    expect(check(url, key, NOW + 100)).toMatchObject({ ok: false, reason: "expired" });
    expect(check(url, key, NOW + 101).ok).toBe(false);
  });
  it("signature_for_one_path_does_not_work_for_a_sibling_path", () => {
    const a = parse(signMediaUrl("videos/abc/a.mp4", NOW + 100, key));
    for (const sibling of ["videos/abc/b.mp4", "videos/abc/a.mp4/", "videos/abd/a.mp4", "videos/abc/A.mp4", "videos/abc/a.mp4x", "abc/a.mp4"]) {
      expect(verifyMediaUrl({ path: sibling, e: a.e, s: a.s }, key, NOW).ok, sibling).toBe(false);
    }
  });
  it("a_signature_over_another_method_label_does_not_verify", () => {
    const exp = NOW + 100;
    const s = createHmac("sha256", key).update(`POST\nvideos/abc/a.mp4\n${exp}`).digest("base64url");
    expect(verifyMediaUrl({ path: "videos/abc/a.mp4", e: String(exp), s }, key, NOW).ok).toBe(false);
    const sGet = createHmac("sha256", key).update(`GET\nvideos/abc/a.mp4\n${exp}`).digest("base64url");
    expect(verifyMediaUrl({ path: "videos/abc/a.mp4", e: String(exp), s: sGet }, key, NOW).ok).toBe(true);
  });
  it("an_unnormalised_path_is_refused_even_with_a_matching_signature", () => {
    // Sign the raw string by hand (signMediaUrl refuses it) to prove verify normalises before trusting the MAC.
    const exp = NOW + 100;
    for (const p of ["videos/../secret.txt", "videos//a.mp4", "/videos/a.mp4", "videos/a.mp4\0"]) {
      const s = createHmac("sha256", key).update(`GET\n${p}\n${exp}`).digest("base64url");
      expect(verifyMediaUrl({ path: p, e: String(exp), s }, key, NOW).ok, p).toBe(false);
    }
  });
  it("uses_a_constant_time_compare", () => {
    expect(readFileSync("src/server/storage/sign.ts", "utf8")).toContain("timingSafeEqual");
  });
});

describe("resignIfNear", () => {
  it("keeps_a_fresh_url_and_renews_one_near_expiry", () => {
    const fresh = signMediaUrl("videos/abc/a.mp4", NOW + DEFAULT_LIFETIME_SEC, key);
    expect(resignIfNear(fresh, NOW, 600, key)).toBe(fresh);
    const near = signMediaUrl("videos/abc/a.mp4", NOW + 300, key);
    const renewed = resignIfNear(near, NOW, 600, key)!;
    expect(renewed).not.toBe(near);
    expect(check(renewed, key, NOW)).toMatchObject({ ok: true, exp: NOW + DEFAULT_LIFETIME_SEC });
  });
  it("renews_an_authentic_but_expired_url_and_refuses_a_forged_one", () => {
    const expired = signMediaUrl("videos/abc/a.mp4", NOW - 10, key);
    expect(check(resignIfNear(expired, NOW, 600, key)!).ok).toBe(true);
    const forged = signMediaUrl("videos/abc/a.mp4", NOW + 10, other);
    expect(resignIfNear(forged, NOW, 600, key)).toBeNull();
    expect(resignIfNear("/api/media/videos/abc/a.mp4", NOW, 600, key)).toBeNull();
    expect(resignIfNear("/elsewhere/x?e=1&s=2", NOW, 600, key)).toBeNull();
  });
  it("the_default_lifetime_is_four_hours", () => expect(DEFAULT_LIFETIME_SEC).toBe(4 * 3600));
});
