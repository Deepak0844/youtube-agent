import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decryptSecret, encryptSecret, generateMasterKey, hintAllowedFor, hintFor, keyIdOf, makeKeyring, parseMasterKey, VaultError } from "@/server/core/vault-crypto";

const b64 = () => randomBytes(32).toString("base64");
const ring = (k = b64(), prev?: string) => makeKeyring(k, prev);
const PLAIN = "sk-ant-api03-SUPERSECRETVALUE-1234";
afterEach(() => vi.restoreAllMocks());

const failure = (fn: () => unknown): VaultError => {
  try {
    fn();
  } catch (e) {
    return e as VaultError;
  }
  throw new Error("expected throw");
};

describe("master key parsing", () => {
  it("accepts_32_byte_base64_and_generates_one", () => {
    expect(parseMasterKey(generateMasterKey()).length).toBe(32);
  });
  it.each(["", "abc", Buffer.alloc(31).toString("base64"), Buffer.alloc(33).toString("base64"), "not base64 !!", undefined])("rejects_%s", (v) => {
    expect(() => parseMasterKey(v as string)).toThrow(VaultError);
  });
  it("rejects_non_canonical_base64_and_whitespace", () => {
    const good = Buffer.alloc(32).toString("base64"); // 43 x "A" + "="
    expect(parseMasterKey(good).length).toBe(32);
    expect(() => parseMasterKey(good.slice(0, 42) + "B=")).toThrow(VaultError); // same bytes, non-canonical trailing bits
    for (const bad of [` ${good}`, `${good} `, `${good}\n`, `${good}\r\n`, good.slice(0, 20) + " " + good.slice(21), good.replace("=", "")])
      expect(() => parseMasterKey(bad)).toThrow(VaultError);
  });
  it("key_id_is_stable_and_short", () => {
    const k = parseMasterKey(b64());
    expect(keyIdOf(k)).toMatch(/^[0-9a-f]{8}$/);
    expect(keyIdOf(k)).toBe(keyIdOf(Buffer.from(k)));
  });
});

describe("encrypt/decrypt", () => {
  it("round_trips", () => {
    const r = ring();
    expect(decryptSecret(r, "a", encryptSecret(r, "a", PLAIN))).toBe(PLAIN);
    expect(decryptSecret(r, "a", encryptSecret(r, "a", ""))).toBe("");
    expect(decryptSecret(r, "a", encryptSecret(r, "a", "ключ-🔑"))).toBe("ключ-🔑");
  });
  it("same_value_twice_gives_different_nonce_and_ciphertext", () => {
    const r = ring();
    const a = encryptSecret(r, "a", PLAIN);
    const b = encryptSecret(r, "a", PLAIN);
    expect(a.nonce.equals(b.nonce)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.nonce.length).toBe(12);
  });
  it("10k_encryptions_never_repeat_a_nonce", () => {
    const r = ring();
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) seen.add(encryptSecret(r, "a", "x").nonce.toString("hex"));
    expect(seen.size).toBe(10_000);
  });
  it("tampering_any_ciphertext_or_nonce_byte_fails", () => {
    const r = ring();
    const rec = encryptSecret(r, "a", PLAIN);
    for (let i = 0; i < rec.ciphertext.length; i++) {
      const c = Buffer.from(rec.ciphertext);
      c[i] = c[i]! ^ 1;
      expect(() => decryptSecret(r, "a", { ...rec, ciphertext: c })).toThrow(VaultError);
    }
    for (let i = 0; i < 12; i++) {
      const n = Buffer.from(rec.nonce);
      n[i] = n[i]! ^ 1;
      expect(() => decryptSecret(r, "a", { ...rec, nonce: n })).toThrow(VaultError);
    }
  });
  it("truncated_or_extended_or_empty_ciphertext_fails", () => {
    const r = ring();
    const rec = encryptSecret(r, "a", PLAIN);
    for (const c of [rec.ciphertext.subarray(0, -1), rec.ciphertext.subarray(0, 8), Buffer.alloc(0), Buffer.concat([rec.ciphertext, Buffer.from([0])])])
      expect(() => decryptSecret(r, "a", { ...rec, ciphertext: c })).toThrow(VaultError);
    expect(() => decryptSecret(r, "a", { ...rec, nonce: rec.nonce.subarray(0, 11) })).toThrow(VaultError);
  });
  it("any_ciphertext_shorter_than_the_tag_throws_including_15_bytes", () => {
    const r = ring();
    const rec = encryptSecret(r, "a", PLAIN);
    for (let n = 0; n <= 16; n++) {
      const e = failure(() => decryptSecret(r, "a", { ...rec, ciphertext: randomBytes(n) }));
      expect(e).toBeInstanceOf(VaultError);
      expect(e.code).toBe("decrypt_failed");
    }
  });
  it("ciphertext_moved_to_another_name_fails_aad", () => {
    const r = ring();
    const rec = encryptSecret(r, "provider.a.key", PLAIN);
    expect(() => decryptSecret(r, "provider.b.key", rec)).toThrow(VaultError);
  });
  it("key_id_relabel_to_another_known_key_fails", () => {
    const k1 = b64();
    const k2 = b64();
    const rec = encryptSecret(makeKeyring(k1), "a", PLAIN);
    const both = makeKeyring(k2, k1);
    expect(decryptSecret(both, "a", rec)).toBe(PLAIN);
    expect(() => decryptSecret(both, "a", { ...rec, keyId: both.current.id })).toThrow(VaultError);
  });
  it("wrong_master_key_fails_closed_never_empty_string", () => {
    const rec = encryptSecret(ring(), "a", PLAIN);
    const e = failure(() => decryptSecret(ring(), "a", rec));
    expect(e.code).toBe("wrong_key");
  });
  it("same_key_id_forged_with_different_key_still_fails", () => {
    const rec = encryptSecret(ring(), "a", PLAIN);
    const other = ring();
    expect(() => decryptSecret(other, "a", { ...rec, keyId: other.current.id })).toThrow(VaultError);
  });
});

describe("rotation", () => {
  it("new_writes_use_current_old_rows_still_read_via_previous", () => {
    const oldK = b64();
    const newK = b64();
    const old = encryptSecret(makeKeyring(oldK), "a", PLAIN);
    const r = makeKeyring(newK, oldK);
    expect(decryptSecret(r, "a", old)).toBe(PLAIN);
    const fresh = encryptSecret(r, "a", PLAIN);
    expect(fresh.keyId).toBe(r.current.id);
    expect(fresh.keyId).not.toBe(old.keyId);
    expect(() => decryptSecret(makeKeyring(newK), "a", old)).toThrow(VaultError);
  });
  it("rejects_identical_current_and_previous", () => {
    const k = b64();
    expect(() => makeKeyring(k, k)).toThrow(VaultError);
  });
});

describe("no plaintext leaks", () => {
  it("errors_and_logs_never_contain_plaintext_or_key", () => {
    const spies = (["log", "error", "warn", "info", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const k = b64();
    const r = makeKeyring(k);
    const rec = encryptSecret(r, "a", PLAIN);
    const errs: Error[] = [];
    for (const f of [
      () => decryptSecret(ring(), "a", rec),
      () => decryptSecret(r, "b", rec),
      () => decryptSecret(r, "a", { ...rec, ciphertext: rec.ciphertext.subarray(1) }),
      () => parseMasterKey(PLAIN),
    ]) {
      try {
        f();
      } catch (e) {
        errs.push(e as Error);
        console.error(e);
      }
    }
    const props = errs.map((e) => Object.getOwnPropertyNames(e).map((p) => String((e as unknown as Record<string, unknown>)[p])));
    const blob = JSON.stringify([errs.map((e) => [String(e), e.message, e.stack]), props, spies.map((s) => s.mock.calls.map(String))]);
    expect(blob).not.toContain(PLAIN);
    expect(blob).not.toContain(k);
    expect(blob).not.toContain(rec.ciphertext.toString("base64"));
    for (const e of errs) expect(e.message).toMatch(/^vault: /);
  });
  it("ciphertext_does_not_contain_plaintext", () => {
    const rec = encryptSecret(ring(), "a", PLAIN);
    expect(Buffer.concat([rec.ciphertext, rec.nonce]).toString("latin1")).not.toContain(PLAIN);
  });
});

describe("hint", () => {
  it("shows_last_4_only_for_values_of_24_plus_chars", () => {
    expect(hintFor(PLAIN)).toBe("1234");
    expect(hintFor("short")).toBe("");
    expect(hintFor("a".repeat(23))).toBe("");
    expect(hintFor("a".repeat(24))).toBe("aaaa");
  });
  it("hint_can_be_disabled_and_is_never_allowed_for_totp_or_owner_names", () => {
    expect(hintFor(PLAIN, false)).toBe("");
    expect(hintAllowedFor("provider.a.key")).toBe(true);
    expect(hintAllowedFor("totp.owner")).toBe(false);
    expect(hintAllowedFor("owner.totp")).toBe(false);
  });
});
