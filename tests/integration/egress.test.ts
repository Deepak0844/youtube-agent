import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDockerUp } from "../support/infra";
import {
  containerIp,
  createInternalNetwork,
  docker,
  dockerOk,
  removeLabelled,
  runIn,
  startContainer,
  TEST_LABEL,
} from "../support/docker";

// Topology under test (all names unique per run, nothing published to the host):
//   client containers --(yt-fetcher-<run>, --internal)--> egress proxy --(default bridge)--> internet/DNS
//                                                               \--(yt-standin-<run>, --internal, "public" 11.x subnet)--> stand-in site
// The stand-in network uses a subnet that classifies as public, so allowed traffic is testable offline.

const RUN = randomBytes(4).toString("hex");
const LABEL = `${TEST_LABEL}=egress-${RUN}`;
const PROXY_IMAGE = "ytstudio-egress-proxy:dev";
const RENDER_IMAGE = "ytstudio-render:dev";
const NODE_IMAGE = "node:22-alpine";
const FETCHER_NET = `yt-fetcher-${RUN}`;
const STANDIN_NET = `yt-standin-${RUN}`;
const TOKEN = randomBytes(32).toString("hex");
const ADMIN_PORT = 3129;

const port = () => randomInt(20_000, 30_000); // below Chrome's restricted-port ranges, above 1024
const HOST_PORT_PLACEHOLDER = 0; // filled once the host canary listens

// ---------------------------------------------------------------------------------------------
// Scripts that run inside containers (plain JS, node:22).

const CANARY = `
const net = require("net");
const port = Number(process.env.PORT);
for (const host of process.env.HOSTS.split(",")) {
  net.createServer((c) => {
    console.log("HIT " + c.remoteAddress);
    c.on("error", () => {});
    c.end("HTTP/1.1 200 OK\\r\\nContent-Length: 6\\r\\nConnection: close\\r\\n\\r\\ncanary");
  }).listen(port, host, () => console.log("READY " + host));
}`;

const STANDIN = `
const http = require("http");
http.createServer((req, res) => {
  console.log("HIT " + req.method + " " + req.url);
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/page") {
    const subs = (u.searchParams.get("subs") || "").split(",").filter(Boolean);
    res.writeHead(200, { "content-type": "text/html" });
    return res.end("<!doctype html><title>standin</title>" + subs.map((s) => '<img src="' + s + '">').join(""));
  }
  if (u.pathname === "/redirect") { res.writeHead(302, { location: u.searchParams.get("to") }); return res.end(); }
  if (u.pathname === "/ok.svg") {
    res.writeHead(200, { "content-type": "image/svg+xml" });
    return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("standin ok");
}).listen(Number(process.env.PORT), "0.0.0.0", () => console.log("READY"));`;

// Sends each request in $REQS through the proxy and prints {id: result} as JSON.
const PROXY_CLIENT = `
const http = require("http"), tls = require("tls");
const reqs = JSON.parse(process.env.REQS);
const [PH, PP] = process.env.PROXY.split(":");
const T = 8000;
const trim = (s) => s.slice(0, 600);
function get(r) {
  return new Promise((done) => {
    const req = http.request({ host: r.proxy || PH, port: Number(PP), method: "GET", path: "http://" + r.host + ":" + r.port + (r.path || "/"),
      headers: { host: r.host + ":" + r.port }, timeout: T });
    req.on("response", (res) => {
      let b = ""; res.setEncoding("utf8");
      res.on("data", (d) => { b += d; });
      res.on("end", () => done({ status: res.statusCode, body: trim(b), location: res.headers.location }));
      res.on("error", (e) => done({ status: res.statusCode, body: trim(b), error: e.code || e.message }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => done({ error: e.code || e.message }));
    req.end();
  });
}
function connect(r) {
  return new Promise((done) => {
    const req = http.request({ host: r.proxy || PH, port: Number(PP), method: "CONNECT", path: r.host + ":" + r.port, timeout: T });
    req.on("connect", (res, socket, head) => {
      let b = head.toString("utf8");
      socket.setEncoding("utf8");
      const finish = (extra) => { socket.destroy(); done(Object.assign({ status: res.statusCode }, extra)); };
      if (res.statusCode !== 200) {
        socket.on("data", (d) => { b += d; });
        socket.on("end", () => finish({ body: trim(b) }));
        socket.on("error", () => finish({ body: trim(b) }));
        setTimeout(() => finish({ body: trim(b) }), 2000).unref();
        return;
      }
      if (r.kind === "connect") return finish({});
      const line = "GET " + (r.path || "/") + " HTTP/1.1\\r\\nHost: " + r.host + "\\r\\nConnection: close\\r\\n\\r\\n";
      const s = r.kind === "tls-get" ? tls.connect({ socket, servername: r.host }) : socket;
      let t = "";
      s.setEncoding("utf8");
      s.on("data", (d) => { t += d; });
      s.on("end", () => finish({ tunnelled: trim(t) }));
      s.on("error", (e) => finish({ tunnelled: trim(t), error: e.code || e.message }));
      setTimeout(() => finish({ tunnelled: trim(t), error: "timeout" }), T).unref();
      if (r.kind === "tls-get") s.on("secureConnect", () => s.write(line)); else s.write(line);
    });
    req.on("response", (res) => {
      let b = ""; res.setEncoding("utf8");
      res.on("data", (d) => { b += d; });
      res.on("end", () => done({ status: res.statusCode, body: trim(b) }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => done({ error: e.code || e.message }));
    req.end();
  });
}
Promise.all(reqs.map(async (r) => [r.id, await (r.kind === "get" ? get(r) : connect(r))]))
  .then((e) => console.log(JSON.stringify(Object.fromEntries(e))));`;

// Without proxy variables: direct HTTP, DNS and raw TCP attempts. Prints JSON.
const DIRECT_CLIENT = `
const net = require("net"), dns = require("dns").promises;
const targets = JSON.parse(process.env.TARGETS);
const tcp = (host, port) => new Promise((done) => {
  const s = net.connect({ host, port });
  s.setTimeout(3000, () => { s.destroy(); done("timeout"); });
  s.on("connect", () => { s.destroy(); done("connected"); });
  s.on("error", (e) => done(e.code || e.message));
});
(async () => {
  const out = {};
  out.fetch = await fetch("http://1.1.1.1/", { signal: AbortSignal.timeout(3000) }).then((r) => "status " + r.status, (e) => "error " + ((e.cause && e.cause.code) || e.name));
  out.dns = await dns.lookup("example.com").then((a) => "resolved " + a.address, (e) => "error " + e.code);
  await Promise.all(targets.map(async ([h, p]) => { out[h + ":" + p] = await tcp(h, p); }));
  console.log(JSON.stringify(out));
})();`;

// Chrome Headless Shell from the render image, launched through Remotion's own launcher (the same
// binary and DevTools driver a render uses). openBrowser() hard-codes --no-proxy-server, so this calls
// its launchChrome() by absolute path with an explicit argument list instead.
const CHROME_CLIENT = `
const fs = require("fs");
const { launchChrome } = require("/opt/render/node_modules/@remotion/renderer/dist/browser/Launcher.js");
const urls = JSON.parse(process.env.URLS);
(async () => {
  const userDataDir = fs.mkdtempSync("/tmp/chrome-");
  const browser = await launchChrome({
    executablePath: process.env.REMOTION_BROWSER_EXECUTABLE, userDataDir, timeout: 25000, logLevel: "error", indent: false,
    defaultViewport: { width: 800, height: 600, deviceScaleFactor: 1 },
    args: ["about:blank", "--headless=old", "--no-sandbox", "--disable-setuid-sandbox", "--no-zygote", "--disable-dev-shm-usage",
      "--disable-gpu", "--no-first-run", "--disable-background-networking", "--disable-component-update", "--disable-domain-reliability",
      "--disable-sync", "--no-pings", "--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults",
      "--proxy-server=" + process.env.CHROME_PROXY, "--proxy-bypass-list=<-loopback>",
      "--remote-debugging-port=0", "--user-data-dir=" + userDataDir],
  });
  const page = await browser.newPage({ context: {}, logLevel: "error", indent: false, pageIndex: 0, onBrowserLog: null, onLog: () => {} });
  const out = {};
  for (const url of urls) {
    try {
      const res = await page.goto({ url, timeout: 15000 });
      out[url] = { status: res ? res.status() : null };
    } catch (e) {
      out[url] = { error: String(e && e.message || e).slice(0, 200) };
    }
    await new Promise((r) => setTimeout(r, 1500)); // let subresources settle
  }
  await browser.close({ silent: true });
  console.log("RESULT " + JSON.stringify(out));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });`;

// ---------------------------------------------------------------------------------------------
// Host facts (discovered, not assumed).

function hostLanAddresses(): string[] {
  const out = new Set<string>();
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) out.add(a.address);
  }
  return [...out];
}

function defaultGateway(): string | undefined {
  try {
    if (process.platform === "darwin") {
      return /gateway:\s*(\S+)/.exec(execFileSync("route", ["-n", "get", "default"], { encoding: "utf8" }))?.[1];
    }
    return /default via (\S+)/.exec(execFileSync("ip", ["route", "show", "default"], { encoding: "utf8" }))?.[1];
  } catch {
    return undefined;
  }
}

async function internetReachable(): Promise<boolean> {
  try {
    const res = await fetch("https://example.com/", { signal: AbortSignal.timeout(2000) });
    await res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
}

const LAN = hostLanAddresses();
const GATEWAY = defaultGateway();
const ONLINE = await internetReachable();

// ---------------------------------------------------------------------------------------------
// Shared state.

interface ProxyLog {
  kind: "http" | "connect";
  host: string;
  port: number;
  decision: "allow" | "block" | "error";
  reason?: string;
}
type Result = { status?: number; body?: string; error?: string; location?: string; tunnelled?: string };

const cleanups: Array<() => Promise<void>> = [];
let hostPort = HOST_PORT_PLACEHOLDER;
let hostLoopPort = HOST_PORT_PLACEHOLDER;
const hostHits: string[] = [];
let loopbackCanary: ChildProcess | undefined;
const loopbackHits: string[] = [];
const ports = { canary: port(), standin: port(), loopback: port(), metadata: port() };
let proxyId = "";
let prodProxyId = "";
let badTokenProxyId = "";
let canaryId = "";
let standinId = "";
const ip = { proxyInternal: "", proxyBridge: "", canary: "", standin: "", bridgeGateway: "" };

const hitsIn = async (id: string) => (await docker(["logs", id])).stdout.split("\n").filter((l) => l.startsWith("HIT "));

async function proxyLogs(): Promise<ProxyLog[]> {
  const script = `fetch("http://127.0.0.1:${ADMIN_PORT}/logs",{headers:{authorization:"Bearer "+process.env.T}}).then(r=>r.text()).then(t=>console.log(t))`;
  return JSON.parse(await dockerOk(["exec", "-e", `T=${TOKEN}`, proxyId, "node", "-e", script]));
}

async function viaProxy(reqs: Array<Record<string, unknown>>, proxy = "egress-proxy:3128"): Promise<Record<string, Result>> {
  const r = await runIn(FETCHER_NET, NODE_IMAGE, ["node", "-e", PROXY_CLIENT], { REQS: JSON.stringify(reqs), PROXY: proxy }, { label: LABEL });
  if (r.code !== 0) throw new Error(`proxy client failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

async function waitFor(check: () => Promise<boolean>, what: string, ms = 20_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const ready = (id: string, n = 1) => waitFor(async () => (await docker(["logs", id])).stdout.split("READY").length - 1 >= n, `${id} ready`);
const proxyUp = (id: string) => waitFor(async () => (await docker(["logs", id])).stdout.includes("listening"), `proxy ${id} listening`);

async function createStandinNet(): Promise<() => Promise<void>> {
  // 11.0.0.0/8 is ordinary public unicast; inside this isolated network it stands in for "the internet".
  for (let attempt = 0; ; attempt++) {
    try {
      return await createInternalNetwork(STANDIN_NET, { subnet: `11.${randomInt(1, 255)}.${randomInt(0, 256)}.0/24`, label: LABEL });
    } catch (err) {
      if (attempt >= 4) throw err;
    }
  }
}

beforeAll(async () => {
  await assertDockerUp();
  cleanups.push(() => removeLabelled(LABEL));
  await dockerOk(["build", "-q", "-f", "infra/Dockerfile.egress-proxy", "-t", PROXY_IMAGE, "."], 600_000);
  if ((await docker(["image", "inspect", RENDER_IMAGE])).code !== 0) {
    await dockerOk(["build", "-f", "infra/Dockerfile.render", "-t", RENDER_IMAGE, "."], 900_000);
  }
  if ((await docker(["image", "inspect", NODE_IMAGE])).code !== 0) await dockerOk(["pull", "-q", NODE_IMAGE], 300_000);

  // Host-side servers on the Mac: one on every interface ("::" is dual-stack, a superset of 0.0.0.0) and one
  // on 127.0.0.1 only. OrbStack delivers host.docker.internal traffic to the Mac as 127.0.0.1, so even a
  // loopback-only dev service (Postgres, Next) is one hop away from any container.
  const listenHost = async (bind: string): Promise<number> => {
    const server = net.createServer((c) => {
      hostHits.push(`${bind} <- ${String(c.remoteAddress)}`);
      c.on("error", () => undefined);
      c.end("HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nhost");
    });
    await new Promise<void>((resolve) => server.listen(0, bind, resolve));
    cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
    return (server.address() as net.AddressInfo).port;
  };
  hostPort = await listenHost("::");
  hostLoopPort = await listenHost("127.0.0.1");

  cleanups.push(await createInternalNetwork(FETCHER_NET, { label: LABEL }));
  cleanups.push(await createStandinNet());
  ip.bridgeGateway = await dockerOk(["network", "inspect", "bridge", "--format", "{{(index .IPAM.Config 0).Gateway}}"]);

  canaryId = await startContainer({
    name: `yt-canary-${RUN}`, image: NODE_IMAGE, label: LABEL, networks: [{ network: FETCHER_NET }],
    env: { PORT: String(ports.canary), HOSTS: "0.0.0.0" }, command: ["node", "-e", CANARY],
  });
  standinId = await startContainer({
    name: `yt-standin-${RUN}`, image: NODE_IMAGE, label: LABEL, networks: [{ network: STANDIN_NET }],
    env: { PORT: String(ports.standin) }, command: ["node", "-e", STANDIN],
  });
  await Promise.all([ready(canaryId), ready(standinId)]);
  ip.canary = await containerIp(canaryId, FETCHER_NET);
  ip.standin = await containerIp(standinId, STANDIN_NET);

  const override = [
    `attacker.test=93.184.216.34`, `attacker.test=10.0.0.1`, `evil.test=10.0.0.1`,
    // The public answer is the stand-in: if the proxy ever used it, the stand-in would log a hit.
    `mixed.test=${ip.standin}`, `mixed.test=10.0.0.1`,
    `mixed-rev.test=fd00::1`, `mixed-rev.test=${ip.standin}`,
    `standin.test=${ip.standin}`,
  ].join(",");

  // Proxies are started without --user: the image itself must be non-root (asserted below).
  proxyId = await startContainer({
    name: `egress-proxy-${RUN}`, image: PROXY_IMAGE, label: LABEL, unprivileged: false,
    networks: [{ network: FETCHER_NET, alias: "egress-proxy" }, { network: "bridge" }, { network: STANDIN_NET }],
    env: { NODE_ENV: "test", PROXY_TEST_TOKEN: TOKEN, RESOLVE_OVERRIDE: override },
  });
  const hookProbe = `onlypublic.test=${ip.standin}`;
  prodProxyId = await startContainer({
    name: `egress-proxy-prod-${RUN}`, image: PROXY_IMAGE, label: LABEL, unprivileged: false,
    networks: [{ network: FETCHER_NET, alias: "egress-proxy-prod" }, { network: STANDIN_NET }],
    env: { PROXY_TEST_TOKEN: TOKEN, RESOLVE_OVERRIDE: hookProbe }, // no NODE_ENV: image default (production)
  });
  badTokenProxyId = await startContainer({
    name: `egress-proxy-badtoken-${RUN}`, image: PROXY_IMAGE, label: LABEL, unprivileged: false,
    networks: [{ network: FETCHER_NET, alias: "egress-proxy-badtoken" }, { network: STANDIN_NET }],
    env: { NODE_ENV: "test", PROXY_TEST_TOKEN: "short", RESOLVE_OVERRIDE: hookProbe },
  });
  await Promise.all([proxyUp(proxyId), proxyUp(prodProxyId), proxyUp(badTokenProxyId)]);
  ip.proxyInternal = await containerIp(proxyId, FETCHER_NET);
  ip.proxyBridge = await containerIp(proxyId, "bridge");

  // A canary on the proxy's own loopback (v4 and v6): the classic SSRF target next to a proxy.
  loopbackCanary = spawn("docker", ["exec", "-e", `PORT=${ports.loopback}`, "-e", "HOSTS=127.0.0.1,::1", proxyId, "node", "-e", CANARY], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  let loopbackOut = "";
  loopbackCanary.stdout?.on("data", (d: Buffer) => {
    loopbackOut += d.toString();
    for (const line of d.toString().split("\n")) if (line.startsWith("HIT ")) loopbackHits.push(line);
  });
  await waitFor(async () => loopbackOut.split("READY").length - 1 >= 2, "loopback canary");
}, 900_000);

afterAll(async () => {
  loopbackCanary?.kill("SIGKILL");
  for (const c of cleanups.reverse()) await c().catch(() => undefined);
}, 120_000);

// ---------------------------------------------------------------------------------------------

describe("egress proxy image", () => {
  it("has_no_python", () => {
    const out = execFileSync("bash", ["infra/check-no-python.sh", PROXY_IMAGE], { encoding: "utf8" });
    expect(out).toContain("ok");
  });

  it("runs_as_non_root_with_read_only_root_and_only_the_bundle", async () => {
    const [info] = JSON.parse(await dockerOk(["inspect", proxyId]));
    expect(info.HostConfig.ReadonlyRootfs).toBe(true);
    expect(await dockerOk(["exec", proxyId, "id", "-u"])).not.toBe("0");
    expect(info.HostConfig.PortBindings ?? {}).toEqual({});
    expect(await dockerOk(["run", "--rm", "--entrypoint", "ls", PROXY_IMAGE, "-A", "/app"])).toBe("proxy.js");
    const npm = await docker(["run", "--rm", "--entrypoint", "sh", PROXY_IMAGE, "-c", "command -v npm npx yarn"]);
    expect(npm.stdout.trim()).toBe("");
  });
});

describe("client isolation", () => {
  it("client_has_no_direct_route", async () => {
    const targets = [
      ["1.1.1.1", 80], ["host.docker.internal", hostPort], ["0.250.250.254", hostPort],
      ...LAN.map((a) => [a, hostPort]), [ip.proxyInternal, ADMIN_PORT],
    ];
    const r = await runIn(FETCHER_NET, NODE_IMAGE, ["node", "-e", DIRECT_CLIENT], { TARGETS: JSON.stringify(targets) }, { label: LABEL });
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as Record<string, string>;
    expect(out.fetch).toMatch(/^error /);
    expect(out.dns).toMatch(/^error /);
    for (const [h, p] of targets) expect(out[`${h}:${p}`], `${h}:${p}`).not.toBe("connected");
    const getent = await runIn(FETCHER_NET, NODE_IMAGE, ["getent", "hosts", "example.com"], {}, { label: LABEL });
    expect(getent.code).not.toBe(0);
    expect(hostHits).toEqual([]);
  });

  it("admin_port_is_loopback_only_and_needs_the_token", async () => {
    const script = (auth: string) =>
      `fetch("http://127.0.0.1:${ADMIN_PORT}/logs",{headers:{authorization:${JSON.stringify(auth)}}}).then(r=>console.log(r.status),e=>console.log("ERR",e.cause?.code))`;
    expect(await dockerOk(["exec", proxyId, "node", "-e", script("")])).toBe("401");
    expect(await dockerOk(["exec", proxyId, "node", "-e", script(`Bearer ${"0".repeat(64)}`)])).toBe("401");
    expect(await dockerOk(["exec", proxyId, "node", "-e", script(`Bearer ${TOKEN}`)])).toBe("200");
    const onIface = `fetch("http://${ip.proxyInternal}:${ADMIN_PORT}/logs").then(r=>console.log(r.status),e=>console.log("ERR",e.cause?.code))`;
    expect(await dockerOk(["exec", proxyId, "node", "-e", onIface])).toBe("ERR ECONNREFUSED");
  });
});

describe("test hooks stay off outside NODE_ENV=test with a valid token", () => {
  for (const [name, getId, alias] of [
    ["no_node_env", () => prodProxyId, "egress-proxy-prod"],
    ["bad_token", () => badTokenProxyId, "egress-proxy-badtoken"],
  ] as const) {
    it(`hooks_disabled_${name}`, async () => {
      const id = getId();
      const res = await viaProxy([{ id: "probe", kind: "get", host: "onlypublic.test", port: ports.standin, path: `/hooks-${name}` }], `${alias}:3128`);
      // Override ignored: the name does not resolve, so it never reaches the stand-in.
      expect(res.probe?.status).toBe(502);
      expect(res.probe?.body).toMatch(/^unresolvable/);
      expect((await hitsIn(standinId)).filter((h) => h.includes(`/hooks-${name}`))).toEqual([]);
      const admin = `require("net").connect(${ADMIN_PORT},"127.0.0.1").on("connect",()=>console.log("OPEN")).on("error",e=>console.log(e.code))`;
      expect(await dockerOk(["exec", id, "node", "-e", admin])).toBe("ECONNREFUSED");
      const logs = await docker(["logs", id]);
      expect(logs.stdout + logs.stderr).not.toContain("TEST HOOKS ENABLED");
    });
  }

  it("hooks_enabled_only_on_the_test_proxy", async () => {
    const logs = await docker(["logs", proxyId]);
    expect(logs.stdout + logs.stderr).toContain("TEST HOOKS ENABLED");
  });
});

describe("allowed traffic", () => {
  it("public_standin_loads_through_proxy_plain_and_connect", async () => {
    const res = await viaProxy([
      { id: "get", kind: "get", host: ip.standin, port: ports.standin, path: "/allowed-get" },
      { id: "byname", kind: "get", host: "standin.test", port: ports.standin, path: "/allowed-name" },
      { id: "tunnel", kind: "tunnel-get", host: ip.standin, port: ports.standin, path: "/allowed-tunnel" },
    ]);
    expect(res.get).toMatchObject({ status: 200, body: "standin ok" });
    expect(res.byname).toMatchObject({ status: 200, body: "standin ok" });
    expect(res.tunnel?.status).toBe(200);
    expect(res.tunnel?.tunnelled).toMatch(/^HTTP\/1\.1 200 [\s\S]*\r\n\r\n[\s\S]*standin ok/);
    const hits = await hitsIn(standinId);
    for (const p of ["/allowed-get", "/allowed-name", "/allowed-tunnel"]) expect(hits).toContain(`HIT GET ${p}`);
  });

  it.skipIf(!ONLINE)("public_site_loads_through_proxy (needs internet: skipped when https://example.com is unreachable from the host)", async () => {
    const res = await viaProxy([{ id: "tls", kind: "tls-get", host: "example.com", port: 443 }]);
    expect(res.tls?.status).toBe(200);
    expect(res.tls?.tunnelled).toMatch(/^HTTP\/1\.1 200/);
  });
});

describe("unreachable-address matrix", () => {
  type Canary = "host" | "internal" | "loopback";
  interface Row {
    name: string;
    host: () => string;
    port: () => number;
    cls?: string; // expected class in "blocked: <class>" when it is environment-independent
    canary?: Canary;
    hostname?: boolean; // may legitimately be unresolvable on other engines (e.g. Linux CI)
  }
  const rows: Row[] = [
    { name: "host.internal", host: () => "host.internal", port: () => hostPort, canary: "host", hostname: true },
    { name: "host.docker.internal", host: () => "host.docker.internal", port: () => hostPort, canary: "host", hostname: true },
    { name: "orbstack_host_ip_0.250.250.254", host: () => "0.250.250.254", port: () => hostPort, cls: "reserved", canary: "host" },
    { name: "host.internal_to_mac_127.0.0.1_server", host: () => "host.internal", port: () => hostLoopPort, canary: "host", hostname: true },
    { name: "host.docker.internal_to_mac_127.0.0.1_server", host: () => "host.docker.internal", port: () => hostLoopPort, canary: "host", hostname: true },
    { name: "0.250.250.254_to_mac_127.0.0.1_server", host: () => "0.250.250.254", port: () => hostLoopPort, cls: "reserved", canary: "host" },
    ...LAN.map((a): Row => ({ name: `host_lan_ip_${a}`, host: () => a, port: () => hostPort, canary: "host" })),
    ...(GATEWAY ? [{ name: `lan_gateway_${GATEWAY}`, host: () => GATEWAY, port: () => 80 } as Row] : []),
    { name: "docker_bridge_gateway", host: () => ip.bridgeGateway, port: () => hostPort, canary: "host" },
    { name: "192.168.1.1", host: () => "192.168.1.1", port: () => 80, cls: "private" },
    { name: "10.0.0.1", host: () => "10.0.0.1", port: () => 80, cls: "private" },
    { name: "100.64.0.1", host: () => "100.64.0.1", port: () => 80, cls: "cgnat" },
    { name: "169.254.169.254", host: () => "169.254.169.254", port: () => 80, cls: "metadata" },
    { name: "[::1]", host: () => "[::1]", port: () => ports.loopback, cls: "loopback", canary: "loopback" },
    { name: "[fe80::1]", host: () => "[fe80::1]", port: () => 80, cls: "linklocal" },
    { name: "[::ffff:10.0.0.1]", host: () => "[::ffff:10.0.0.1]", port: () => 80, cls: "private" },
    { name: "2130706433", host: () => "2130706433", port: () => ports.loopback, cls: "loopback", canary: "loopback" },
    { name: "localhost", host: () => "localhost", port: () => ports.loopback, cls: "loopback", canary: "loopback" },
    { name: "proxy_own_ip_internal", host: () => ip.proxyInternal, port: () => 3128 },
    { name: "proxy_own_ip_bridge", host: () => ip.proxyBridge, port: () => 3128, cls: "docker" },
    { name: "proxy_loopback_3128", host: () => "127.0.0.1", port: () => 3128, cls: "loopback" },
    { name: "proxy_admin_port", host: () => "127.0.0.1", port: () => ADMIN_PORT, cls: "loopback" },
    { name: "other_client_container", host: () => ip.canary, port: () => ports.canary, canary: "internal" },
  ];
  const kinds = ["get", "connect"] as const;
  let results: Record<string, Result> = {};
  let logs: ProxyLog[] = [];
  let logsBefore = 0;

  beforeAll(async () => {
    logsBefore = (await proxyLogs()).length;
    results = await viaProxy(rows.flatMap((r) => kinds.map((kind) => ({ id: `${r.name}/${kind}`, kind, host: r.host(), port: r.port() }))));
    logs = (await proxyLogs()).slice(logsBefore);
    // Evidence for review: every row's target, the proxy's answer and its own log entry.
    mkdirSync("test-results", { recursive: true });
    const evidence = rows.flatMap((r) => kinds.map((k) => ({ row: r.name, kind: k, target: `${r.host()}:${r.port()}`, answer: results[`${r.name}/${k}`] })));
    writeFileSync("test-results/egress-matrix.json", JSON.stringify({ evidence, logs }, null, 2));
  }, 120_000);

  const logHost = (h: string) => new URL(`http://${h}`).hostname.replace(/^\[|\]$/g, "");

  it.each(rows.flatMap((r) => kinds.map((k) => [`blocked_${r.name}_${k}`, r, k] as const)))("%s", async (_n, row, kind) => {
    const res = results[`${row.name}/${kind}`];
    const blocked = res?.status === 403 && /^blocked: [a-z]+$/.test(res.body ?? "");
    const unresolvable = row.hostname === true && res?.status === 502 && /^unresolvable/.test(res.body ?? "");
    expect(blocked || unresolvable, JSON.stringify(res)).toBe(true);
    if (row.cls && blocked) expect(res?.body).toBe(`blocked: ${row.cls}`);
    expect(["canary", "host", "standin ok"]).not.toContain(res?.body);
    const mine = logs.filter((l) => l.kind === (kind === "get" ? "http" : "connect") && l.host === logHost(row.host()) && l.port === row.port());
    expect(mine.map((l) => l.decision), JSON.stringify(logs)).toEqual([blocked ? "block" : "error"]);
  });

  it("canaries_saw_zero_connections", async () => {
    expect(hostHits).toEqual([]);
    expect(loopbackHits).toEqual([]);
    expect(await hitsIn(canaryId)).toEqual([]);
  });

  it("proxy_never_looped_or_allowed_anything", () => {
    // One log line per request sent: a request that reached the proxy itself would add a line.
    expect(logs).toHaveLength(rows.length * kinds.length);
    expect(logs.filter((l) => l.decision === "allow")).toEqual([]);
  });
});

describe("dns answers", () => {
  it("redirect_to_private_is_refused", async () => {
    const reqs = ["attacker.test", "evil.test", "mixed.test", "mixed-rev.test"].flatMap((host) =>
      (["get", "connect"] as const).map((kind) => ({ id: `${host}/${kind}`, kind, host, port: ports.standin, path: "/mixed-dns" })),
    );
    const res = await viaProxy(reqs);
    for (const r of reqs) {
      expect(res[r.id]?.status, r.id).toBe(403);
      expect(res[r.id]?.body, r.id).toMatch(/^blocked: (private)$/);
    }
    expect((await hitsIn(standinId)).filter((h) => h.includes("/mixed-dns"))).toEqual([]);
  });

  it("proxy_does_not_follow_redirects", async () => {
    const to = `http://${ip.canary}:${ports.canary}/`;
    const res = await viaProxy([{ id: "r", kind: "get", host: ip.standin, port: ports.standin, path: `/redirect?to=${encodeURIComponent(to)}` }]);
    expect(res.r).toMatchObject({ status: 302, location: to });
    expect(await hitsIn(canaryId)).toEqual([]);
  });
});

describe("chrome through the proxy", () => {
  async function chrome(urls: string[]): Promise<Record<string, { status?: number; error?: string }>> {
    const r = await runIn(
      FETCHER_NET, RENDER_IMAGE, ["node", "-e", CHROME_CLIENT],
      { URLS: JSON.stringify(urls), CHROME_PROXY: "http://egress-proxy:3128" },
      { label: LABEL, extraArgs: ["--shm-size=256m"], timeoutMs: 120_000 },
    );
    const line = r.stdout.split("\n").find((l) => l.startsWith("RESULT "));
    if (r.code !== 0 || !line) throw new Error(`chrome client failed (${r.code}): ${r.stderr.slice(-2000)}`);
    return JSON.parse(line.slice("RESULT ".length));
  }

  it("chrome_uses_proxy_for_subresources", async () => {
    const before = (await proxyLogs()).length;
    const standin = `http://${ip.standin}:${ports.standin}`;
    const subs = [
      `${standin}/ok.svg`,
      `http://169.254.169.254:${ports.metadata}/latest/meta-data/`,
      `http://host.docker.internal:${hostPort}/x.png`,
      `http://127.0.0.1:${ports.loopback}/x.png`,
    ];
    const pageUrl = `${standin}/page?subs=${encodeURIComponent(subs.join(","))}`;
    const redirectUrl = `${standin}/redirect?to=${encodeURIComponent(`http://${ip.canary}:${ports.canary}/hop`)}`;
    const out = await chrome([pageUrl, redirectUrl]);
    expect(out[pageUrl]?.status).toBe(200);

    const hits = await hitsIn(standinId);
    expect(hits.some((h) => h.startsWith("HIT GET /page?"))).toBe(true);
    expect(hits).toContain("HIT GET /ok.svg"); // allowed subresource: Chrome really goes through the proxy
    expect(hits.some((h) => h.startsWith("HIT GET /redirect?"))).toBe(true);

    const logs = (await proxyLogs()).slice(before);
    const decision = (host: string, p: number) => logs.filter((l) => l.host === host && l.port === p).map((l) => l.decision);
    expect(decision("169.254.169.254", ports.metadata), JSON.stringify(logs)).toContain("block");
    expect(decision("host.docker.internal", hostPort)).toContain("block");
    expect(decision("127.0.0.1", ports.loopback)).toContain("block");
    // The redirect hop was re-issued by Chrome through the proxy and refused there.
    expect(decision(ip.canary, ports.canary)).toContain("block");
    expect(logs.filter((l) => l.decision === "allow").every((l) => l.host === ip.standin)).toBe(true);

    expect(hostHits).toEqual([]);
    expect(loopbackHits).toEqual([]);
    expect(await hitsIn(canaryId)).toEqual([]);
  });

  it.skipIf(!ONLINE)("chrome_loads_public_https_via_connect (needs internet: skipped when https://example.com is unreachable from the host)", async () => {
    const before = (await proxyLogs()).length;
    const out = await chrome(["https://example.com/"]);
    expect(out["https://example.com/"]?.status).toBe(200);
    const logs = (await proxyLogs()).slice(before);
    expect(logs).toContainEqual(expect.objectContaining({ kind: "connect", host: "example.com", port: 443, decision: "allow" }));
  });
});

// Last: positive controls prove the canaries would have noticed a connection (zero hits above is meaningful).
describe("canary positive controls", () => {
  it("canaries_detect_direct_connections", async () => {
    // From the proxy's vantage point (default bridge), bypassing the proxy: which host routes are live?
    const hostRoutes: Array<[string, number]> = [
      ...["host.docker.internal", "host.internal", "0.250.250.254"].flatMap((h): Array<[string, number]> => [[h, hostPort], [h, hostLoopPort]]),
      ...LAN.map((a): [string, number] => [a, hostPort]),
      [ip.bridgeGateway, hostPort],
    ];
    const r = await runIn("bridge", NODE_IMAGE, ["node", "-e", DIRECT_CLIENT], { TARGETS: JSON.stringify(hostRoutes) }, { label: LABEL });
    const live = JSON.parse(r.stdout) as Record<string, string>;
    writeFileSync("test-results/egress-controls.json", JSON.stringify({ hostRoutes: live, hostHits }, null, 2));
    // On OrbStack these must all be live (so "zero hits" in the matrix is meaningful); elsewhere a name may not exist.
    for (const h of ["host.docker.internal", "host.internal", "0.250.250.254"]) {
      for (const p of [hostPort, hostLoopPort]) expect(["connected", "ENOTFOUND", "EAI_AGAIN"], `${h}:${p}`).toContain(live[`${h}:${p}`]);
    }
    expect(live[`host.docker.internal:${hostLoopPort}`]).toBe("connected");
    const connected = Object.entries(live).filter(([k, v]) => k.includes(":") && v === "connected").length;
    await waitFor(async () => hostHits.length >= connected, "host canary hits");

    const direct = await runIn(FETCHER_NET, NODE_IMAGE, ["node", "-e", DIRECT_CLIENT], { TARGETS: JSON.stringify([[ip.canary, ports.canary]]) }, { label: LABEL });
    expect(JSON.parse(direct.stdout)[`${ip.canary}:${ports.canary}`]).toBe("connected");
    await waitFor(async () => (await hitsIn(canaryId)).length > 0, "internal canary hit");

    for (const h of ["127.0.0.1", "::1"]) {
      await dockerOk(["exec", proxyId, "node", "-e", `require("net").connect(${ports.loopback},"${h}").on("connect",function(){this.destroy()})`]);
    }
    await waitFor(async () => loopbackHits.length >= 2, "loopback canary hits");
  });
});
