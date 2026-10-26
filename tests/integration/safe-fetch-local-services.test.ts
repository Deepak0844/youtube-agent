import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BlockedAddressError, safeFetch } from "@/server/providers/net/safe-fetch";

// The local-service allow-list (network.local_services) at the fetch layer, with real sockets on loopback.
// "Ollama" below is a plain HTTP server on an ephemeral port; the "own service" is the same kind of server.
const servers: Server[] = [];
let ollama: number;
let ollamaHits = 0;
let other: number;
let redirector: number; // listed; redirects to `other`
let sameOrigin: number; // listed; redirects to itself

function listen(handler: Parameters<typeof createServer>[1]): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer(handler);
    s.listen(0, "127.0.0.1", () => {
      servers.push(s);
      resolve((s.address() as AddressInfo).port);
    });
  });
}

beforeAll(async () => {
  ollama = await listen((_req, res) => {
    ollamaHits++;
    res.end("ollama");
  });
  other = await listen((_req, res) => res.end("other"));
  redirector = await listen((_req, res) => res.writeHead(302, { location: `http://127.0.0.1:${other}/` }).end());
  sameOrigin = await listen((req, res) => {
    if (req.url === "/") res.writeHead(302, { location: "/final" }).end();
    else res.end("final");
  });
});
afterAll(async () => {
  servers.forEach((s) => s.closeAllConnections());
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
});

const lookupTo = (...addrs: string[]) => async () => addrs;
const refused = async (p: Promise<Response>) => {
  const err = await p.catch((e) => e);
  expect(err).toBeInstanceOf(BlockedAddressError);
  return err as BlockedAddressError;
};

describe("typed fetch with a local-service list", () => {
  it("an_allowed_local_service_works_by_ip_and_by_name", async () => {
    const a = await safeFetch(`http://127.0.0.1:${ollama}/api`, undefined, { mode: "typed", localServices: [`127.0.0.1:${ollama}`] });
    expect(await a.text()).toBe("ollama");
    const b = await safeFetch(`http://llm.test:${ollama}/api`, undefined, {
      mode: "typed",
      localServices: [`llm.test:${ollama}`],
      lookup: lookupTo("127.0.0.1"),
    });
    expect(await b.text()).toBe("ollama");
  });

  it("an_unlisted_local_target_is_refused_before_any_connection", async () => {
    const before = ollamaHits;
    const err = await refused(safeFetch(`http://127.0.0.1:${ollama}/`, undefined, { mode: "typed", localServices: [] }));
    expect(err.reason).toBe("not-listed");
    expect((await refused(safeFetch(`http://127.0.0.1:${ollama}/`, undefined, { mode: "typed", localServices: [`127.0.0.1:${other}`] }))).reason).toBe("not-listed");
    expect(ollamaHits).toBe(before);
  });

  it("the_list_is_exact_host_and_port_not_an_alias", async () => {
    // localhost is listed, the numeric spelling of the same machine is not
    const err = await refused(
      safeFetch(`http://127.0.0.1:${ollama}/`, undefined, { mode: "typed", localServices: [`localhost:${ollama}`], lookup: lookupTo("127.0.0.1") }),
    );
    expect(err.reason).toBe("not-listed");
  });

  it("a_typed_call_that_forgets_the_list_reaches_nothing_local", async () => {
    const before = ollamaHits;
    // @ts-expect-error typed mode requires localServices at compile time; at run time a missing list means an empty one
    const err = await refused(safeFetch(`http://127.0.0.1:${ollama}/`, undefined, { mode: "typed" }));
    expect(err.reason).toBe("not-listed");
    for (const [host, ip] of [["lan.test", "192.168.1.20"], ["dock.test", "172.17.0.2"], ["cg.test", "100.64.0.9"], ["v6.test", "fd00::5"]]) {
      // @ts-expect-error same: no list given
      const e = await refused(safeFetch(`http://${host}:${ollama}/`, undefined, { mode: "typed", lookup: lookupTo(ip!) }));
      expect(e.reason).toBe("not-listed");
    }
    expect(ollamaHits).toBe(before);
  });

  it.each([
    ["loopback postgres", "http://127.0.0.1:5432/", "127.0.0.1"],
    ["loopback redis", "http://127.0.0.1:6379/", "127.0.0.1"],
    ["lan postgres", "http://pg.lan.test:5432/", "192.168.1.20"],
    ["docker redis", "http://r.test:6379/", "172.17.0.2"],
    ["searxng port", "http://127.0.0.1:8888/", "127.0.0.1"],
  ])("own_service_ports_are_refused_with_no_list_and_no_own_services_%s", async (_n, url, ip) => {
    const err = await refused(safeFetch(url, undefined, { mode: "typed", localServices: [], lookup: lookupTo(ip!) }));
    expect(err.reason).toBe("own-service");
  });

  it("own_service_ports_stay_refused_even_when_the_entry_was_written_by_hand", async () => {
    const err = await refused(safeFetch("http://127.0.0.1:6379/", undefined, { mode: "typed", localServices: ["127.0.0.1:6379"] }));
    expect(err.reason).toBe("own-service");
  });

  it("an_unreadable_own_service_setting_refuses_every_local_target", async () => {
    const old = process.env.SEARXNG_URL;
    process.env.SEARXNG_URL = "not a url";
    try {
      await expect(safeFetch(`http://127.0.0.1:${ollama}/`, undefined, { mode: "typed", localServices: [`127.0.0.1:${ollama}`] })).rejects.toThrow(/own-service/);
    } finally {
      if (old === undefined) delete process.env.SEARXNG_URL;
      else process.env.SEARXNG_URL = old;
    }
  });

  it("in_production_nothing_local_is_reachable_until_the_own_service_urls_are_set", async () => {
    const keep = { ...process.env };
    const env = process.env as Record<string, string | undefined>;
    env.NODE_ENV = "production";
    for (const n of ["RENDER_RUNNER_URL", "FETCHER_URL", "SEARXNG_URL", "EGRESS_PROXY_URL"]) delete env[n];
    try {
      const err = await refused(safeFetch(`http://127.0.0.1:${ollama}/`, undefined, { mode: "typed", localServices: [`127.0.0.1:${ollama}`] }));
      expect(err.reason).toBe("not-listed");
      Object.assign(env, { RENDER_RUNNER_URL: "http://127.0.0.1:7001", FETCHER_URL: "http://127.0.0.1:7002", SEARXNG_URL: "http://127.0.0.1:8888", EGRESS_PROXY_URL: "http://127.0.0.1:3128" });
      const res = await safeFetch(`http://127.0.0.1:${ollama}/`, undefined, { mode: "typed", localServices: [`127.0.0.1:${ollama}`] });
      expect(await res.text()).toBe("ollama");
    } finally {
      for (const k of Object.keys(env)) if (!(k in keep)) delete env[k];
      Object.assign(env, keep);
    }
  });

  it("public_targets_do_not_need_the_list", async () => {
    // refused later by the connection, not by the list: lookup says public, nothing listens, so it fails to connect
    const err = await safeFetch("http://93.184.216.34:9/", undefined, { mode: "typed", localServices: [], timeoutMs: 300 }).catch((e) => e);
    expect(err).not.toBeInstanceOf(BlockedAddressError);
  });

  it("an_own_service_typed_into_the_list_is_still_refused", async () => {
    const err = await refused(
      safeFetch(`http://127.0.0.1:${ollama}/`, undefined, {
        mode: "typed",
        localServices: [`127.0.0.1:${ollama}`],
        ownServices: [{ host: "127.0.0.1", port: ollama }],
      }),
    );
    expect(err.reason).toBe("own-service");
  });

  it("an_own_service_by_name_or_alias_is_refused_even_when_listed", async () => {
    for (const host of ["alias.test", "pg.internal"]) {
      const err = await refused(
        safeFetch(`http://${host}:${ollama}/`, undefined, {
          mode: "typed",
          localServices: [`${host}:${ollama}`],
          ownServices: [{ host: "127.0.0.1", port: ollama }],
          lookup: lookupTo("127.0.0.1"),
        }),
      );
      expect(err.reason).toBe("own-service");
    }
  });

  it("the_apps_own_ports_are_refused_even_if_a_row_was_written_by_hand", async () => {
    // 5432 is in the fixed own-port set: refused as an own service before the list is even read
    for (const entry of ["127.0.0.1:5432", "localhost:6379"]) {
      const host = entry.split(":")[0]!;
      const port = Number(entry.split(":")[1]);
      const err = await refused(
        safeFetch(`http://${host}:${port}/`, undefined, { mode: "typed", localServices: [entry], lookup: lookupTo("127.0.0.1") }),
      );
      expect(err.reason).toBe("own-service");
    }
  });

  it.each([
    ["metadata ip", "169.254.169.254", "80", "metadata"],
    ["metadata ecs", "169.254.170.2", "80", "metadata"],
    ["alibaba metadata", "100.100.100.200", "80", "metadata"],
    ["link-local", "169.254.1.1", "80", "linklocal"],
  ])("a_listed_%s_is_refused", async (_n, ip, port, reason) => {
    const err = await refused(safeFetch(`http://${ip}:${port}/`, undefined, { mode: "typed", localServices: [`${ip}:${port}`] }));
    expect(["metadata", "not-listed", "linklocal"]).toContain(err.reason);
    if (reason === "metadata") expect(err.reason).toBe("metadata");
  });

  it("a_listed_name_that_resolves_to_metadata_or_link_local_is_refused", async () => {
    for (const ip of ["169.254.169.254", "169.254.9.9", "fd00:ec2::254", "fe80::1"]) {
      const err = await refused(
        safeFetch(`http://rebind.test:7000/`, undefined, { mode: "typed", localServices: ["rebind.test:7000"], lookup: lookupTo(ip) }),
      );
      expect(["metadata", "linklocal"]).toContain(err.reason);
    }
  });

  it("a_listed_name_with_one_bad_answer_among_good_ones_is_refused", async () => {
    const err = await refused(
      safeFetch(`http://mixed.test:7000/`, undefined, { mode: "typed", localServices: ["mixed.test:7000"], lookup: lookupTo("127.0.0.1", "169.254.169.254") }),
    );
    expect(err.reason).toBe("metadata");
  });
});

describe("bind-any addresses are never a target", () => {
  it.each([
    ["0.0.0.0", `http://0.0.0.0:PORT/`],
    ["::", `http://[::]:PORT/`],
    ["mapped 0.0.0.0", `http://[::ffff:0.0.0.0]:PORT/`],
    ["0 shorthand", `http://0:PORT/`],
    ["0.0.0.0 octal", `http://0000.0.0.0:PORT/`],
    ["decimal zero", `http://0x0:PORT/`],
  ])("typed_refuses_%s_even_when_listed_and_in_both_modes", async (_n, tpl) => {
    const url = tpl.replace("PORT", String(ollama));
    const before = ollamaHits;
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    for (const options of [
      { mode: "typed" as const, localServices: [] },
      { mode: "typed" as const, localServices: [`${host}:${ollama}`, `0.0.0.0:${ollama}`, `[::]:${ollama}`] },
      { mode: "indirect" as const },
    ]) {
      const err = await refused(safeFetch(url, undefined, options));
      expect(err.reason).toBe("reserved");
    }
    expect(ollamaHits).toBe(before); // 0.0.0.0 reaches this machine's listeners on macOS; it never connected
  });

  it("a_name_resolving_to_a_bind_any_address_is_refused", async () => {
    for (const ip of ["0.0.0.0", "::", "::ffff:0.0.0.0"]) {
      const err = await refused(safeFetch(`http://any.test:${ollama}/`, undefined, { mode: "typed", localServices: [`any.test:${ollama}`], lookup: lookupTo(ip) }));
      expect(err.reason).toBe("reserved");
    }
  });

  it("an_own_service_listed_as_bind_any_blocks_every_local_address_on_that_port", async () => {
    // ADR 0003 Task 2: a 0.0.0.0 / :: own-service entry means 'every interface', not only loopback
    const cases: Array<[string, string]> = [
      ["127.0.0.1", "loopback"],
      ["192.168.1.5", "private"],
      ["10.0.0.9", "private"],
      ["172.17.0.2", "docker"],
      ["100.64.1.1", "cgnat"],
      ["fd00::5", "private"],
      ["::1", "loopback"],
    ];
    for (const anyHost of ["0.0.0.0", "::", "[::]", "::ffff:0.0.0.0"]) {
      for (const [ip] of cases) {
        const err = await refused(
          safeFetch(`http://svc.test:5432/`, undefined, {
            mode: "typed",
            localServices: [],
            ownServices: [{ host: anyHost, port: 5432 }],
            lookup: lookupTo(ip),
          }),
        );
        expect(err.reason, `${anyHost} vs ${ip}`).toBe("own-service");
      }
    }
  });

  it("a_bind_any_own_service_does_not_block_other_ports", async () => {
    const res = await safeFetch(`http://127.0.0.1:${ollama}/`, undefined, {
      mode: "typed",
      localServices: [`127.0.0.1:${ollama}`],
      ownServices: [{ host: "0.0.0.0", port: 5432 }],
    });
    expect(await res.text()).toBe("ollama");
  });
});

describe("redirects from a listed service", () => {
  it("a_redirect_to_another_local_port_is_strict_even_if_that_port_is_listed", async () => {
    const before = ollamaHits;
    const err = await refused(
      safeFetch(`http://127.0.0.1:${redirector}/`, undefined, {
        mode: "typed",
        localServices: [`127.0.0.1:${redirector}`, `127.0.0.1:${other}`],
      }),
    );
    expect(err.reason).toBe("loopback");
    expect(ollamaHits).toBe(before);
  });

  it("a_same_origin_redirect_stays_allowed", async () => {
    const res = await safeFetch(`http://127.0.0.1:${sameOrigin}/`, undefined, { mode: "typed", localServices: [`127.0.0.1:${sameOrigin}`] });
    expect(await res.text()).toBe("final");
  });

  it("a_redirect_into_metadata_is_refused", async () => {
    const meta = await listen((_req, res) => res.writeHead(302, { location: "http://169.254.169.254/latest" }).end());
    const err = await refused(safeFetch(`http://127.0.0.1:${meta}/`, undefined, { mode: "typed", localServices: [`127.0.0.1:${meta}`] }));
    expect(err.reason).toBe("metadata");
  });
});
