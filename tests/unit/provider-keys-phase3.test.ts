import { describe, expect, it } from "vitest";
import { isAuditEvent } from "@/server/core/audit-events";
import { canEnable, canRoute, priceLabel, routeScope } from "@/server/core/media-catalog";
import { PROVIDERS, checkKeyShape, keyTestRequest } from "@/server/core/provider-keys";

const GOOD: Record<string, string> = {
  google_tts: "AIzaSyA-abcdefghijklmnopqrstuvwxyz01234",
  azure_speech: "0123456789abcdef0123456789abcdef",
  coverr: "abcdefghijklmnop0123456789",
  fal: "12345678-abcd-4abc-8abc-123456789abc:0123456789abcdef0123456789abcdef",
  voicestudio: "my-voicestudio-key-123",
  local_voice: "my-local-voice-key-123",
};
const BAD: Record<string, string> = {
  google_tts: "sk-not-a-google-key-0123456789abcdef",
  azure_speech: "short",
  coverr: "has spaces in it 0123456789",
  fal: "no-colon-in-this-fal-key-0123456789",
  voicestudio: "x",
  local_voice: "x",
};

describe("new key slots", () => {
  it("each new id is listed with its role", () => {
    const role = (id: string) => PROVIDERS.find((p) => p.id === id)?.role;
    expect(["google_tts", "azure_speech", "voicestudio", "local_voice"].map(role)).toEqual(["Voice", "Voice", "Voice", "Voice"]);
    expect(role("fal")).toBe("Image");
    expect(role("coverr")).toBe("Stock media");
  });
  it.each(Object.keys(GOOD))("%s: good sample passes, bad sample fails", (id) => {
    expect(checkKeyShape(id, GOOD[id]).ok).toBe(true);
    const bad = checkKeyShape(id, BAD[id]);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.message).not.toContain(BAD[id]!);
  });
  it("only Google lists voices for free; the rest are 'checked on first use' (no request is built)", () => {
    expect(keyTestRequest("google_tts" as never, "k")).toMatchObject({ url: "https://texttospeech.googleapis.com/v1/voices", method: "GET" });
    for (const id of ["azure_speech", "coverr", "fal", "voicestudio", "local_voice"]) expect(keyTestRequest(id as never, "k"), id).toBeNull();
  });
});

describe("providers page rules", () => {
  const free = { price: { unit: "free", microUsd: 0 }, local: false };
  const paid = { price: { unit: "per_1k_chars", microUsd: 100 }, local: false };
  it("enabling_without_key_refused_except_free_and_loopback", () => {
    expect(canEnable(paid, false).ok).toBe(false);
    expect(canEnable(paid, true).ok).toBe(true);
    expect(canEnable(free, false).ok).toBe(true);
    expect(canEnable({ price: {}, local: true }, false).ok).toBe(true);
    expect(canEnable({ price: {}, local: false }, false).ok).toBe(false);
  });
  it("a route target must be enabled and priced", () => {
    expect(canRoute({ enabled: false, price: free }).ok).toBe(false);
    expect(canRoute({ enabled: true, price: {} }).ok).toBe(false);
    expect(canRoute({ enabled: true, price: free.price }).ok).toBe(true);
  });
  it("price labels never come from an unpriced rule", () => {
    expect(priceLabel({})).toBe("price not set");
    expect(priceLabel({ unit: "free", microUsd: 0 })).toBe("free");
    expect(priceLabel({ unit: "per_1k_chars", microUsd: 30_000 })).toBe("about $0.018"); // 600 chars
    expect(priceLabel({ unit: "per_second", microUsd: 10_000 })).toBe("about $0.30"); // 30 s
    expect(priceLabel({ unit: "per_image", microUsd: 40_000 })).toBe("about $0.04");
  });
  it("route scopes", () => {
    for (const s of ["default", "format:short", "format:long", "kind:tsx", "kind:ai"]) expect(routeScope(s), s).toBe(s);
    for (const s of ["format:wide", "kind:nope", "x", "", "toString"]) expect(routeScope(s), s).toBeNull();
  });
  it("new audit event", () => {
    expect(isAuditEvent("provider.toggled")).toBe(true);
  });
});
