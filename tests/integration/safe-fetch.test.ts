import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BlockedAddressError, BlockedRedirectError, safeFetch as realSafeFetch, type SafeFetchOptions } from "@/server/providers/net/safe-fetch";

// These tests exercise the address policy, redirects, pinning and timeouts, not the owner's allow-list (that is
// safe-fetch-local-services.test.ts). Typed calls therefore list the exact host:port they were pointed at, as an owner
// who typed that URL into /settings/system would have. Own services, metadata and bind-any are still refused first.
type Loose = Omit<SafeFetchOptions, "mode" | "localServices"> & { mode: "typed" | "indirect"; localServices?: readonly string[] };
const safeFetch = (url: string, init: RequestInit | undefined, o: Loose): Promise<Response> => {
  if (o.mode === "indirect" || o.localServices) return realSafeFetch(url, init, o as SafeFetchOptions);
  const u = new URL(url);
  const entry = `${u.hostname}:${u.port || (u.protocol === "https:" ? 443 : 80)}`;
  return realSafeFetch(url, init, { ...o, mode: "typed", localServices: [entry] } as SafeFetchOptions);
};

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

// Two "hub" servers on different loopback ports: each records every request and, given ?to=&status=, redirects.
interface Seen {
  url: string;
  method: string;
  headers: IncomingMessage["headers"];
  body: string;
}
const hubs: Array<{ port: number; seen: Seen[] }> = [];
async function startHub(): Promise<void> {
  const seen: Seen[] = [];
  const { server, port } = await listen((req, res) => {
    let body = "";
    req.on("data", (d: Buffer) => (body += d.toString()));
    req.on("end", () => {
      seen.push({ url: req.url ?? "", method: req.method ?? "", headers: req.headers, body });
      const q = new URL(req.url ?? "/", "http://x").searchParams;
      const to = q.get("to");
      if (to) res.writeHead(Number(q.get("status") ?? "302"), { location: to }).end();
      else res.end("hub");
    });
  });
  servers.push(server);
  hubs.push({ port, seen });
}
const go = (to: string, status = 302) => `/?status=${status}&to=${encodeURIComponent(to)}`;
const byHost = (map: Record<string, string>) => async (host: string) => {
  const a = map[host.toLowerCase()];
  if (!a) throw new Error(`unexpected lookup ${host}`);
  return [a];
};

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
  await startHub();
  await startHub();
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

  it("typed_refuses_own_service_via_ipv4_mapped_literal", async () => {
    const err = await safeFetch(`http://[::ffff:127.0.0.1]:${ok}/`, undefined, {
      mode: "typed",
      ownServices: [{ host: "127.0.0.1", port: ok }],
    }).catch((e) => e);
    expect(err).toBeInstanceOf(BlockedAddressError);
    expect(err.reason).toBe("own-service");
  });

  it("typed_refuses_own_service_listed_by_hostname", async () => {
    const err = await safeFetch(`http://127.0.0.1:${ok}/`, undefined, {
      mode: "typed",
      ownServices: [{ host: "localhost", port: ok }],
      lookup: lookupTo("::1", "127.0.0.1"),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(BlockedAddressError);
    expect(err.reason).toBe("own-service");
  });

  it("typed_refuses_own_service_on_any_loopback_address", async () => {
    const err = await safeFetch(`http://127.0.0.2:${ok}/`, undefined, {
      mode: "typed",
      ownServices: [{ host: "127.0.0.1", port: ok }],
    }).catch((e) => e);
    expect(err).toBeInstanceOf(BlockedAddressError);
    expect(err.reason).toBe("own-service");
  });

  it("own_service_refused_via_redirect_hop", async () => {
    // redirect target public.test resolves to the own service's mapped spelling
    const err = await safeFetch(`http://127.0.0.1:${redirectToOk}/`, undefined, {
      mode: "typed",
      ownServices: [{ host: "127.0.0.1", port: ok }],
      lookup: lookupTo("::ffff:127.0.0.1"),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(BlockedAddressError);
    expect(err.reason).toBe("own-service");
  });

  it("indirect_also_checks_own_services", async () => {
    const err = await safeFetch("http://pub.test:8080/", undefined, {
      mode: "indirect",
      ownServices: [{ host: "93.184.216.34", port: 8080 }],
      lookup: lookupTo("93.184.216.34"),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(BlockedAddressError);
    expect(err.reason).toBe("own-service");
  });

  it("own_service_lookup_failure_fails_closed", async () => {
    const err = await safeFetch(`http://127.0.0.1:${ok}/`, undefined, {
      mode: "typed",
      ownServices: [{ host: "pg", port: ok }],
      lookup: async () => {
        throw Object.assign(new Error("getaddrinfo ENOTFOUND pg"), { code: "ENOTFOUND" });
      },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(BlockedAddressError);
    expect(err.reason).toBe("own-service");
    expect(err.message).toContain("pg");
  });

  it("own_service_empty_answer_fails_closed", async () => {
    const err = await safeFetch(`http://127.0.0.1:${ok}/`, undefined, {
      mode: "typed",
      ownServices: [{ host: "pg", port: ok }],
      lookup: async () => [],
    }).catch((e) => e);
    expect(err).toBeInstanceOf(BlockedAddressError);
    expect(err.reason).toBe("own-service");
  });

  it("own_service_ip_literal_entry_needs_no_lookup", async () => {
    let looked = 0;
    const res = await safeFetch(`http://127.0.0.1:${ok}/`, undefined, {
      mode: "typed",
      ownServices: [{ host: "10.9.9.9", port: ok }],
      lookup: async () => {
        looked++;
        return ["127.0.0.1"];
      },
    });
    expect(await res.text()).toBe("ok");
    expect(looked).toBe(0);
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
    // Doc 2 §9.6: the typed policy covers the typed origin only. Leaving it (here to another port) is strict.
    const err = await safeFetch(`http://127.0.0.1:${redirectToOk}/`, undefined, { mode: "typed", lookup: lookupTo("127.0.0.1") }).catch((e) => e);
    expect(err).toBeInstanceOf(BlockedAddressError);
    expect(err.reason).toBe("loopback");
    const [a] = hubs as [(typeof hubs)[number]];
    const res = await safeFetch(`http://127.0.0.1:${a.port}${go("/followed")}`, undefined, { mode: "typed" });
    expect(await res.text()).toBe("hub");
    expect(a.seen.at(-1)?.url).toBe("/followed");
  });

  it("typed_redirect_same_origin_stays_typed", async () => {
    const [a] = hubs as [(typeof hubs)[number]];
    // Absolute, differently-cased spelling of the same origin: still typed, still allowed to reach loopback.
    const res = await safeFetch(`http://Feed.Test:${a.port}${go(`http://feed.test:${a.port}/same`)}`, undefined, {
      mode: "typed",
      lookup: byHost({ "feed.test": "127.0.0.1" }),
    });
    expect(await res.text()).toBe("hub");
    expect(a.seen.at(-1)?.url).toBe("/same");
  });

  it("typed_redirect_cross_origin_to_loopback_refused", async () => {
    const [a] = hubs as [(typeof hubs)[number]];
    const before = a.seen.length;
    const err = await safeFetch(`http://feed.test:${a.port}${go(`http://other.test:${a.port}/x`)}`, undefined, {
      mode: "typed",
      lookup: byHost({ "feed.test": "127.0.0.1", "other.test": "127.0.0.1" }),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(BlockedAddressError);
    expect(err.reason).toBe("loopback");
    expect(a.seen.length).toBe(before + 1); // only the first hop arrived
  });

  it("typed_redirect_cross_origin_to_private_refused", async () => {
    const [a] = hubs as [(typeof hubs)[number]];
    const err = await safeFetch(`http://127.0.0.1:${a.port}${go("http://nas.test/")}`, undefined, {
      mode: "typed",
      lookup: byHost({ "nas.test": "192.168.1.20" }),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(BlockedAddressError);
    expect(err.reason).toBe("private");
  });

  it("typed_redirect_cross_origin_to_metadata_refused", async () => {
    const [a] = hubs as [(typeof hubs)[number]];
    const err = await safeFetch(`http://127.0.0.1:${a.port}${go("http://meta.test/latest")}`, undefined, {
      mode: "typed",
      lookup: byHost({ "meta.test": "169.254.169.254" }),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(BlockedAddressError);
    expect(err.reason).toBe("metadata");
  });

  it("typed_redirect_to_other_port_same_host_is_cross_origin", async () => {
    const [a, b] = hubs as [(typeof hubs)[number], (typeof hubs)[number]];
    const before = b.seen.length;
    const err = await safeFetch(`http://127.0.0.1:${a.port}${go(`http://127.0.0.1:${b.port}/x`)}`, undefined, { mode: "typed" }).catch((e) => e);
    expect(err).toBeInstanceOf(BlockedAddressError);
    expect(err.reason).toBe("loopback");
    expect(b.seen.length).toBe(before);
  });

  it("same_origin_redirect_keeps_headers", async () => {
    const [a] = hubs as [(typeof hubs)[number]];
    const res = await safeFetch(
      `http://127.0.0.1:${a.port}${go("/kept", 307)}`,
      { method: "POST", body: "payload", headers: { "x-api-key": "k1", authorization: "Bearer t", "content-type": "text/plain" } },
      { mode: "typed" },
    );
    expect(await res.text()).toBe("hub");
    const last = a.seen.at(-1);
    expect(last).toMatchObject({ url: "/kept", method: "POST", body: "payload" });
    expect(last?.headers["x-api-key"]).toBe("k1");
    expect(last?.headers.authorization).toBe("Bearer t");
  });

  it("cross_origin_307_with_body_is_refused", async () => {
    const [a, b] = hubs as [(typeof hubs)[number], (typeof hubs)[number]];
    const before = b.seen.length;
    const err = await safeFetch(
      `http://127.0.0.1:${a.port}${go(`http://127.0.0.1:${b.port}/leak`, 307)}`,
      { method: "POST", body: "secret-body", headers: { "x-api-key": "k1" } },
      { mode: "typed" },
    ).catch((e) => e);
    // Refused on the redirect decision itself, before the next hop is even resolved.
    expect(err).toBeInstanceOf(BlockedRedirectError);
    expect(err.reason).toBe("cross-origin-redirect-with-body");
    expect(b.seen.length).toBe(before);
  });

  it("cross_origin_redirect_drops_custom_secret_headers", async () => {
    // A followed cross-origin hop must classify public, which no local stand-in can; the header decision is
    // covered by tests/unit/safe-fetch-redirect.test.ts. Here: the secret never reaches the other port.
    const [a, b] = hubs as [(typeof hubs)[number], (typeof hubs)[number]];
    const before = b.seen.length;
    await safeFetch(`http://127.0.0.1:${a.port}${go(`http://127.0.0.1:${b.port}/leak`)}`, { headers: { "xi-api-key": "k2" } }, { mode: "typed" }).catch(
      () => undefined,
    );
    expect(b.seen.slice(before).filter((s) => s.headers["xi-api-key"])).toEqual([]);
  });

  it("connects_to_validated_ip_not_second_lookup", async () => {
    const [a] = hubs as [(typeof hubs)[number]];
    const calls: string[] = [];
    const res = await safeFetch(`http://one.test:${a.port}${go("/next")}`, undefined, {
      mode: "typed",
      lookup: async (host) => {
        calls.push(host);
        return ["127.0.0.1"];
      },
    });
    await res.text();
    // each hop looked up exactly once; the connect itself never looks up again
    expect(calls).toEqual(["one.test", "one.test"]);
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

  it("times_out_when_dns_lookup_never_resolves", async () => {
    const start = Date.now();
    await expect(
      safeFetch("http://slow.test/", undefined, { mode: "typed", timeoutMs: 300, lookup: () => new Promise<string[]>(() => undefined) }),
    ).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("connect_hang_respects_timeout", async () => {
    // Non-routable address: connect hangs (or fails fast with ENETUNREACH); either way the call must end in time.
    const start = Date.now();
    await expect(
      safeFetch("http://172.17.0.2:5432/", {}, { mode: "typed", timeoutMs: 500 }),
    ).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(1500);
  });

  it("times_out_when_server_never_answers", async () => {
    await expect(safeFetch(`http://127.0.0.1:${hung}/`, undefined, { mode: "typed", timeoutMs: 300 })).rejects.toThrow();
  });
});
