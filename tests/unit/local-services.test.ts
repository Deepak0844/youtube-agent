import { describe, expect, it } from "vitest";
import {
  MAX_LOCAL_SERVICES,
  matchLocalService,
  ownServicePorts,
  parseLocalServicesInput,
  validateLocalService,
} from "@/server/core/local-services";

const OWN = new Set([5432, 6379, 8888, 3128, 3129, 3000]);
const ok = (raw: string) => {
  const r = validateLocalService(raw, OWN);
  expect(r, raw).toMatchObject({ ok: true });
  return r.ok ? r.entry : "";
};
const bad = (raw: string) => {
  const r = validateLocalService(raw, OWN);
  expect(r.ok, `${raw} should be refused`).toBe(false);
  if (!r.ok) expect(r.reason.length).toBeGreaterThan(0);
};

describe("accepted entries", () => {
  it("accepts the usual local model servers, normalised", () => {
    expect(ok("localhost:11434")).toBe("localhost:11434");
    expect(ok("127.0.0.1:1234")).toBe("127.0.0.1:1234");
    expect(ok("  LocalHost:11434 ")).toBe("localhost:11434");
    expect(ok("host.docker.internal:11434")).toBe("host.docker.internal:11434");
    expect(ok("192.168.1.20:8000")).toBe("192.168.1.20:8000");
    expect(ok("100.64.0.5:11434")).toBe("100.64.0.5:11434"); // CGNAT (Tailscale)
    expect(ok("[::1]:11434")).toBe("[::1]:11434");
    expect(ok("[FD00:0:0:0:0:0:0:5]:9000")).toBe("[fd00::5]:9000");
    expect(ok("voicestudio.lan:7860")).toBe("voicestudio.lan:7860");
  });
});

describe("refused entries (hostile)", () => {
  it.each([
    // bind-any: a listening address, never a destination
    "0.0.0.0:11434", "0.0.0.0:5432", "[::]:6379", "[::]:11434", "[::ffff:0.0.0.0]:11434", "[0:0:0:0:0:0:0:0]:80", "0.1.2.3:80", "0:80",
    // own services by port, whatever the host spelling
    "127.0.0.1:5432", "localhost:6379", "LOCALHOST:5432", "host.docker.internal:5432", "192.168.1.5:6379", "ip6-localhost:8888",
    "[::1]:5432", "127.0.0.2:3128", "localhost:3000", "localhost:3129",
    // cloud metadata
    "169.254.169.254:80", "169.254.170.2:80", "100.100.100.200:80", "192.0.0.192:80", "[fd00:ec2::254]:80", "169.254.1.1:80",
    // legacy numeric spellings
    "2130706433:11434", "0x7f000001:11434", "0177.0.0.1:11434", "127.1:11434", "127.0.1:11434", "0x7f.0.0.1:11434", "017700000001:80", "127.000.000.001:80", "1.2.3.4.5:80",
    // IPv4-mapped / compatible IPv6
    "[::ffff:127.0.0.1]:11434", "[::ffff:7f00:1]:11434", "[::ffff:169.254.169.254]:80", "[::127.0.0.1]:80", "[::7f00:1]:80",
    // IPv6 shapes
    "::1:11434", "[::1]", "[fe80::1]:80", "[fe80::1%eth0]:80", "[::1%25lo]:80", "[2001:db8::1]:80x",
    // userinfo, scheme, path, query, fragment
    "user@localhost:11434", "user:pw@localhost:11434", "http://localhost:11434", "localhost:11434/", "localhost:11434/api", "localhost:11434?x=1", "localhost:11434#a", "localhost@evil.test:11434", "localhost:11434@evil.test:80",
    // trailing dots, empty parts
    "localhost.:11434", "127.0.0.1.:11434", "example..com:80", ".example.com:80", "-bad.example:80", "bad-.example:80", "bad_name.example:80",
    // wildcards, ranges, lists
    "*:11434", "*.lan:11434", "192.168.1.0/24:80", "10.0.0.1-10.0.0.9:80", "localhost:11434-11500", "localhost:*", "localhost:11434,localhost:1234", "localhost:11434 localhost:1234", "[1-5]:80",
    // ports
    "localhost:0", "localhost:65536", "localhost:-1", "localhost:011434", "localhost:1e3", "localhost:0x2c9a", "localhost:", "localhost", ":11434", "", "   ", "localhost:١١٤٣٤",
    // public IP literal is not a local service; link-local and multicast neither
    "8.8.8.8:80", "224.0.0.1:80", "255.255.255.255:80", "240.0.0.1:80",
    // control characters and unicode tricks
    "local\nhost:80","local\u0000host:80", "ｌｏｃａｌｈｏｓｔ:80", "lоcalhost:80",
  ])("%j", (raw) => bad(raw));

  it("refuses an over-long host and non-strings", () => {
    bad(`${"a".repeat(64)}.example:80`);
    bad(`${"a.".repeat(130)}example:80`);
    expect(validateLocalService(42 as unknown as string, OWN).ok).toBe(false);
    expect(validateLocalService(null as unknown as string, OWN).ok).toBe(false);
  });
});

describe("list parsing", () => {
  it("collapses duplicates (including spelling differences) and keeps order", () => {
    const r = parseLocalServicesInput("localhost:11434\nLOCALHOST:11434\n[::1]:1234\n[0:0:0:0:0:0:0:1]:1234\n127.0.0.1:1234", OWN);
    expect(r).toEqual({ ok: true, entries: ["localhost:11434", "[::1]:1234", "127.0.0.1:1234"] });
  });
  it("ignores blank lines and accepts an empty list", () => {
    expect(parseLocalServicesInput("\n\n  \n", OWN)).toEqual({ ok: true, entries: [] });
    expect(parseLocalServicesInput("localhost:1\r\nlocalhost:2\r\n", OWN)).toEqual({ ok: true, entries: ["localhost:1", "localhost:2"] });
  });
  it("reports every bad line by number and never echoes the bad text", () => {
    const r = parseLocalServicesInput("localhost:11434\nzzmarker.lan:80x\nlocalhost:5432", OWN);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.map((e) => e.line)).toEqual([2, 3]);
      expect(JSON.stringify(r.errors)).not.toContain("zzmarker");
    }
  });
  it("caps the number of entries", () => {
    const many = Array.from({ length: MAX_LOCAL_SERVICES + 1 }, (_, i) => `localhost:${20000 + i}`).join("\n");
    expect(parseLocalServicesInput(many, OWN).ok).toBe(false);
    const max = Array.from({ length: MAX_LOCAL_SERVICES }, (_, i) => `localhost:${20000 + i}`).join("\n");
    expect(parseLocalServicesInput(max, OWN).ok).toBe(true);
  });
  it("refuses an absurdly large input before parsing it", () => {
    expect(parseLocalServicesInput("a".repeat(100_000), OWN).ok).toBe(false);
  });
});

describe("own service ports", () => {
  it("always include the fixed ones and read the deployment URLs", () => {
    const p = ownServicePorts({
      DATABASE_URL: "postgres://u:p@127.0.0.1:55432/db",
      REDIS_URL: "redis://127.0.0.1:56379",
      SEARXNG_URL: "http://127.0.0.1:18888",
      RENDER_RUNNER_URL: "http://127.0.0.1:7001",
      FETCHER_URL: "http://127.0.0.1:7002",
      OWN_SERVICE_PORTS: "9001, 9002,junk,70000",
    });
    for (const n of [5432, 6379, 8888, 3128, 3129, 3000, 55432, 56379, 18888, 7001, 7002, 9001, 9002]) expect(p.has(n), String(n)).toBe(true);
    expect(p.has(70000)).toBe(false);
  });
  it("survives unparseable URLs and defaults ports by scheme", () => {
    const p = ownServicePorts({ DATABASE_URL: "not a url", REDIS_URL: "redis://cache" });
    expect(p.has(5432)).toBe(true);
    expect(p.has(6379)).toBe(true);
  });
  it("the validator uses the set it is given", () => {
    expect(validateLocalService("localhost:9001", new Set([9001])).ok).toBe(false);
    expect(validateLocalService("localhost:9001", new Set([9002])).ok).toBe(true);
  });
});

describe("matching a URL against the list", () => {
  const list = ["localhost:11434", "127.0.0.1:1234", "[::1]:9000", "192.168.1.20:8000"];
  const m = (u: string) => matchLocalService(list, new URL(u));
  it("matches exact host and port only", () => {
    expect(m("http://localhost:11434/api/tags")).toBe(true);
    expect(m("http://LOCALHOST:11434")).toBe(true);
    expect(m("http://127.0.0.1:1234/v1")).toBe(true);
    expect(m("http://[::1]:9000")).toBe(true);
    expect(m("http://[0:0:0:0:0:0:0:1]:9000")).toBe(true);
    expect(m("http://2130706433:1234")).toBe(true); // the URL parser turns it into 127.0.0.1
  });
  it("does not match other ports, hosts, aliases or sub-domains", () => {
    expect(m("http://localhost:11435")).toBe(false);
    expect(m("http://localhost:80")).toBe(false);
    expect(m("http://127.0.0.1:11434")).toBe(false); // alias of a listed name is not listed
    expect(m("http://localhost.:11434")).toBe(false);
    expect(m("http://a.localhost:11434")).toBe(false);
    expect(m("http://evil.localhost:11434")).toBe(false);
    expect(m("http://192.168.1.21:8000")).toBe(false);
    expect(m("http://user:pw@localhost:5432")).toBe(false);
  });
  it("uses the default port for a URL without one", () => {
    expect(matchLocalService(["localhost:80"], new URL("http://localhost/"))).toBe(true);
    expect(matchLocalService(["localhost:443"], new URL("https://localhost/"))).toBe(true);
    expect(matchLocalService(["localhost:443"], new URL("http://localhost/"))).toBe(false);
  });
  it("ignores invalid stored entries instead of trusting them", () => {
    expect(matchLocalService(["0.0.0.0:80", "*:80", 5 as unknown as string], new URL("http://0.0.0.0/"))).toBe(false);
  });
});
