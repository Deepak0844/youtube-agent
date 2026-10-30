import { describe, expect, it } from "vitest";
import { PROVIDERS as CATALOG } from "@/server/core/llm-catalog";
import { PROVIDERS as KEY_SLOTS } from "@/server/core/provider-keys";
import { LOCAL_PROVIDERS, PROVIDER_ENDPOINTS, keySlotFor } from "@/server/llm/provider-endpoints";

describe("provider endpoints", () => {
  it("every_catalog_provider_has_an_endpoint_entry_and_a_key_slot_or_is_local", () => {
    const slots = new Set<string>(KEY_SLOTS.filter((p) => p.role === "Language model").map((p) => p.id));
    for (const p of CATALOG) {
      expect(PROVIDER_ENDPOINTS[p.id], p.id).toBeDefined();
      if ((LOCAL_PROVIDERS as readonly string[]).includes(p.id)) expect(keySlotFor(p.id), p.id).toBeNull();
      else {
        expect(keySlotFor(p.id), p.id).toBe(p.id);
        expect(slots.has(p.id), p.id).toBe(true);
      }
    }
    expect(Object.keys(PROVIDER_ENDPOINTS).sort()).toEqual(CATALOG.map((p) => p.id).sort());
  });
  it("anthropic_uses_the_native_adapter_the_rest_openai_compatible", () => {
    for (const p of CATALOG) expect(PROVIDER_ENDPOINTS[p.id].adapter, p.id).toBe(p.id === "anthropic" ? "anthropic" : p.id === "claude_code" ? "claude-code" : "openai-compatible");
  });
  it("fixed hosted providers have an https base url with no credentials, query or trailing slash; the rest have none", () => {
    for (const p of CATALOG) {
      const e = PROVIDER_ENDPOINTS[p.id];
      if (p.needsBaseUrl || p.id === "claude_code") expect(e.baseUrl, p.id).toBeNull(); // claude_code is a local process (ADR 0014)
      else {
        const u = new URL(e.baseUrl!);
        expect(u.protocol, p.id).toBe("https:");
        expect(u.username + u.password + u.search + u.hash, p.id).toBe("");
        expect(e.baseUrl!.endsWith("/"), p.id).toBe(false);
      }
    }
  });
  it("every entry names its source with a docs url and the check date", () => {
    for (const p of CATALOG) expect(PROVIDER_ENDPOINTS[p.id].sourceNote, p.id).toMatch(/https:\/\/\S+.*2026-10-(27|31)|2026-10-(27|31).*https:\/\/\S+/);
  });
  it("key slot lookup refuses non-catalog names", () => {
    for (const bad of ["elevenlabs", "pexels", "__proto__", "toString", ""]) expect(() => keySlotFor(bad as never)).toThrow();
  });
});
