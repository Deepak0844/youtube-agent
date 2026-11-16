import { describe, expect, it } from "vitest";
import { classifyAddress } from "@/server/core/net-policy";
import { BlockedAddressError, safeFetch } from "@/server/providers/net/safe-fetch";

// OrbStack answers host.docker.internal with 0.250.250.254 (inside the reserved 0.0.0.0/8). A typed address the owner has LISTED may
// use it, so a container can reach a local VoiceStudio or Ollama. Nothing else changes: classifyAddress still says "reserved" (the
// egress sandbox keeps refusing it), neighbouring addresses stay blocked, and the app's own ports are still refused.
const HOST = "0.250.250.254";
const to = (ip: string) => async () => [ip];
const run = (url: string, localServices: string[], ip = HOST) =>
  safeFetch(url, undefined, { mode: "typed", localServices, lookup: to(ip), timeoutMs: 300 }).then(
    () => "connected" as const,
    (e: unknown) => e,
  );

describe("OrbStack host address for a listed, typed local service", () => {
  it("is still classified reserved for everyone else (egress proxy, untyped fetches)", () => {
    expect(classifyAddress(HOST)).toBe("reserved");
  });
  it("a typed fetch to a LISTED host:port gets past the address check (any later failure is the connection, not the policy)", async () => {
    const r = await run("http://host.docker.internal:3900/health", ["host.docker.internal:3900"]);
    expect(r instanceof BlockedAddressError, String(r)).toBe(false);
  });
  it("an UNLISTED host:port is refused as not-listed, not as reserved", async () => {
    const r = await run("http://host.docker.internal:3900/health", ["host.docker.internal:3901"]);
    expect(r).toBeInstanceOf(BlockedAddressError);
    expect((r as BlockedAddressError).reason).toBe("not-listed");
  });
  it("the indirect (model-written) mode still refuses it as reserved", async () => {
    const r = await safeFetch("http://host.docker.internal:3900/", undefined, { mode: "indirect", lookup: to(HOST), timeoutMs: 300 }).catch((e: unknown) => e);
    expect(r).toBeInstanceOf(BlockedAddressError);
    expect((r as BlockedAddressError).reason).toBe("reserved");
  });
  it("only that one address: its neighbours in 0.250.250.x stay reserved even when listed", async () => {
    for (const ip of ["0.250.250.253", "0.250.250.255", "0.250.250.1", "0.250.250.200", "0.0.0.1"]) {
      const r = await run("http://host.docker.internal:3900/", ["host.docker.internal:3900"], ip);
      expect(r, ip).toBeInstanceOf(BlockedAddressError);
      expect((r as BlockedAddressError).reason, ip).toBe("reserved");
    }
  });
  it("the app's own ports are still refused on it, even when listed", async () => {
    const prev = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://u:p@postgres:5432/ytstudio";
    try {
      const r = await run("http://host.docker.internal:5432/", ["host.docker.internal:5432"]);
      expect(r).toBeInstanceOf(BlockedAddressError);
      expect((r as BlockedAddressError).reason).toBe("own-service");
    } finally {
      if (prev === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prev;
    }
  });
});
