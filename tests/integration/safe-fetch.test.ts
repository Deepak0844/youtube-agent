import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BlockedAddressError, safeFetch } from "@/server/providers/net/safe-fetch";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

function listen(handler: Handler): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}

const servers: Server[] = [];
let ok: number;
let hung: number;
let redirectToOk: number;
let redirectToMetadataLiteral: number;
let redirectChain: number;
let hostSeen: string | undefined;

beforeAll(async () => {
  const a = await listen((req, res) => {
    hostSeen = req.headers.host;
    res.end("ok");
  });
  ok = a.port;
  const b = await listen(() => {
    /* never answers */
  });
  hung = b.port;
  const c = await listen((_req, res) => {
    res.writeHead(302, { location: `http://public.test:${ok}/` }).end();
  });
  redirectToOk = c.port;
  const d = await listen((_req, res) => {
    res.writeHead(302, { location: "http://169.254.169.254/latest" }).end();
  });
  redirectToMetadataLiteral = d.port;
  const e = await listen((req, res) => {
    const n = Number(new URL(req.url ?? "/", "http://x").searchParams.get("n") ?? "0");
    res.writeHead(302, { location: `/?n=${n + 1}` }).end();
  });
  redirectChain = e.port;
  servers.push(a.server, b.server, c.server, d.server, e.server);
});

afterAll(async () => {
  servers.forEach((s) => s.closeAllConnections());
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
});

const lookupTo = (...addrs: string[]) => async () => addrs;

describe("safeFetch", () => {
  it("indirect_refuses_loopback_target", async () => {
    const err = await safeFetch(`http://public.test:${ok}/`, undefined, { mode: "indirect", lookup: lookupTo("127.0.0.1") }).catch((e) => e);
    expect(err).toBeInstanceOf(BlockedAddressError);
    expect(err.reason).toBe("loopback");
  });

  it("typed_allows_loopback_target", async () => {
    const res = await safeFetch(`http://internal.test:${ok}/`, undefined, { mode: "typed", lookup: lookupTo("127.0.0.1") });
    expect(await res.text()).toBe("ok");
    expect(hostSeen).toBe(`internal.test:${ok}`);
  });

  it("typed_refuses_own_service_port", async () => {
    const err = await safeFetch(`http://127.0.0.1:${ok}/`, undefined, {
      mode: "typed",
      ownServices: [{ host: "127.0.0.1", port: ok }],
    }).catch((e) => e);
    expect(err).toBeInstanceOf(BlockedAddressError);
    expect(err.reason).toBe("own-service");
  });

  it("typed_refuses_own_service_via_hostname_resolving_to_it", async () => {
    const err = await safeFetch(`http://alias.test:${ok}/`, undefined, {
      mode: "typed",
      ownServices: [{ host: "127.0.0.1", port: ok }],
      lookup: lookupTo("127.0.0.1"),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(BlockedAddressError);
    expect(err.reason).toBe("own-service");
  });

  it("typed_refuses_metadata_address", async () => {
    const err = await safeFetch("http://meta.test/", undefined, { mode: "typed", lookup: lookupTo("169.254.169.254") }).catch((e) => e);
    expect(err).toBeInstanceOf(BlockedAddressError);
    expect(err.reason).toBe("metadata");
  });

  it("refuses_when_any_resolved_address_is_private", async () => {
    const err = await safeFetch("http://mixed.test/", undefined, { mode: "indirect", lookup: lookupTo("93.184.216.34", "10.0.0.5") }).catch((e) => e);
    expect(err).toBeInstanceOf(BlockedAddressError);
    expect(err.address).toBe("10.0.0.5");
    expect(err.reason).toBe("private");
  });

  it.each([
    ["decimal", "http://2130706433/"],
    ["hex dotted", "http://0x7f.1/"],
    ["ipv6 loopback", "http://[::1]/"],
    ["ipv4-mapped ipv6", "http://[::ffff:127.0.0.1]/"],
    ["plain", "http://127.0.0.1/"],
  ])("indirect_refuses_loopback_literal_%s", async (_n, url) => {
    let looked = 0;
    const err = await safeFetch(url, undefined, {
      mode: "indirect",
      lookup: async () => {
        looked++;
        return ["93.184.216.34"];
      },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(BlockedAddressError);
    expect(err.reason).toBe("loopback");
    expect(looked).toBe(0);
  });

  it("redirect_hop_to_metadata_literal_is_refused_in_typed_mode", async () => {
    const err = await safeFetch(`http://127.0.0.1:${redirectToMetadataLiteral}/`, undefined, { mode: "typed" }).catch((e) => e);
    expect(err).toBeInstanceOf(BlockedAddressError);
    expect(err.reason).toBe("metadata");
  });

  it("redirect_hop_revalidates_resolved_address", async () => {
    // typed: first hop is loopback (allowed); redirect target public.test resolves to metadata -> refused
    const err = await safeFetch(`http://127.0.0.1:${redirectToOk}/`, undefined, {
      mode: "typed",
      lookup: lookupTo("169.254.169.254"),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(BlockedAddressError);
    expect(err.reason).toBe("metadata");
  });

  it("redirect_hop_follows_to_validated_target", async () => {
    const res = await safeFetch(`http://127.0.0.1:${redirectToOk}/`, undefined, { mode: "typed", lookup: lookupTo("127.0.0.1") });
    expect(await res.text()).toBe("ok");
  });

  it("connects_to_validated_ip_not_second_lookup", async () => {
    const calls: string[] = [];
    const res = await safeFetch(`http://127.0.0.1:${redirectToOk}/`, undefined, {
      mode: "typed",
      lookup: async (host) => {
        calls.push(host);
        return ["127.0.0.1"];
      },
    });
    await res.text();
    // literal first hop is not looked up; redirect hop looked up exactly once
    expect(calls).toEqual(["public.test"]);
  });

  it("lookup_called_once_per_hop_for_hostnames", async () => {
    const calls: string[] = [];
    const res = await safeFetch(`http://one.test:${ok}/`, undefined, {
      mode: "typed",
      lookup: async (host) => {
        calls.push(host);
        return ["127.0.0.1"];
      },
    });
    await res.text();
    expect(calls).toEqual(["one.test"]);
  });

  it.each(["file:///etc/passwd", "ftp://example.com/x", "gopher://example.com/"])("refuses_non_http_scheme_%s", async (url) => {
    await expect(safeFetch(url, undefined, { mode: "typed" })).rejects.toThrow(/scheme/i);
  });

  it("follows_at_most_maxRedirects", async () => {
    await expect(
      safeFetch(`http://127.0.0.1:${redirectChain}/?n=0`, undefined, { mode: "typed", maxRedirects: 3 }),
    ).rejects.toThrow(/redirect/i);
    const seen: string[] = [];
    // with a count check: exactly maxRedirects+1 requests are made
    const counter = await listen((req, res) => {
      seen.push(req.url ?? "");
      const n = Number(new URL(req.url ?? "/", "http://x").searchParams.get("n") ?? "0");
      res.writeHead(302, { location: `/?n=${n + 1}` }).end();
    });
    servers.push(counter.server);
    await safeFetch(`http://127.0.0.1:${counter.port}/?n=0`, undefined, { mode: "typed", maxRedirects: 2 }).catch(() => undefined);
    expect(seen).toHaveLength(3);
  });

  it("times_out_when_server_never_answers", async () => {
    await expect(safeFetch(`http://127.0.0.1:${hung}/`, undefined, { mode: "typed", timeoutMs: 300 })).rejects.toThrow();
  });
});
