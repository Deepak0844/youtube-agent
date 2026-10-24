import { lookup } from "node:dns/promises";
import http from "node:http";
import net from "node:net";
import { classifyAddress } from "../../src/server/core/net-policy";
import { loadTestHooks } from "./test-hooks";

// SECURITY CONTROL: the fetcher's only way out. An HTTP forward proxy (absolute-URI requests for
// plain HTTP, CONNECT tunnels for everything else) that resolves every destination itself, refuses
// the request if ANY answer is non-public (net-policy is the single definition of "public"), and then
// connects to the validated IP literal so no second lookup can be rebound. It never follows redirects:
// each hop is a new request from the client and is validated again here.

const PORT = 3128;
const DNS_TIMEOUT_MS = 5_000;
const CONNECT_TIMEOUT_MS = 10_000;
const IDLE_TIMEOUT_MS = 120_000;
// RFC 9110 hop-by-hop headers, plus proxy credentials that must never travel upstream.
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-connection", "proxy-authorization", "proxy-authenticate",
  "te", "trailer", "transfer-encoding", "upgrade", "host",
]);
// CONNECT authority: host:port or [v6]:port; no userinfo, path, query or whitespace.
const AUTHORITY_RE = /^(\[[0-9a-fA-F:.]+\]|[^\s/@?#[\]:]+):([0-9]{1,5})$/;

type Kind = "http" | "connect";
type Decision = "allow" | "block" | "error";

class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly decision: Decision,
  ) {
    super(body);
  }
}

const hooks = loadTestHooks(process.env);

function audit(kind: Kind, host: string, port: number, decision: Decision, reason?: string, address?: string): void {
  const entry = { kind, host, port, decision, ...(reason ? { reason } : {}), ...(address ? { address } : {}) };
  console.log(JSON.stringify({ t: new Date().toISOString(), ...entry }));
  hooks?.record(entry);
}

function bare(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

async function resolveHost(host: string): Promise<string[]> {
  if (net.isIP(host) !== 0) return [host];
  const forced = hooks?.override(host);
  if (forced) return forced;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("ETIMEOUT")), DNS_TIMEOUT_MS);
  });
  try {
    return (await Promise.race([lookup(host, { all: true, order: "ipv4first" }), timeout])).map((a) => a.address);
  } finally {
    clearTimeout(timer);
  }
}

// Every answer must be public; the request is refused outright otherwise (no "pick the good one").
async function validated(host: string): Promise<string[]> {
  let addresses: string[];
  try {
    addresses = await resolveHost(host);
  } catch (err) {
    throw new Refusal(502, `unresolvable: ${(err as NodeJS.ErrnoException).code ?? "error"}`, "error");
  }
  if (addresses.length === 0) throw new Refusal(502, "unresolvable: no answers", "error");
  for (const address of addresses) {
    const cls = classifyAddress(address);
    if (cls !== "public") throw new Refusal(403, `blocked: ${cls}`, "block");
  }
  return addresses;
}

function connectTo(address: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    // An IP literal host: net performs no DNS lookup, so this is the address that was validated.
    const socket = net.connect({ host: address, port, family: net.isIP(address) });
    const fail = (err: Error) => {
      socket.destroy();
      reject(err);
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => fail(new Error("connect timeout")));
    socket.once("error", fail);
    socket.once("connect", () => {
      socket.removeListener("error", fail);
      socket.setTimeout(IDLE_TIMEOUT_MS, () => socket.destroy());
      resolve(socket);
    });
  });
}

async function connectFirst(addresses: string[], port: number): Promise<{ socket: net.Socket; address: string }> {
  for (const address of addresses) {
    try {
      return { socket: await connectTo(address, port), address };
    } catch {
      // try the next validated address
    }
  }
  throw new Refusal(502, "upstream unreachable", "error");
}

async function open(kind: Kind, host: string, port: number): Promise<net.Socket> {
  try {
    const { socket, address } = await connectFirst(await validated(host), port);
    audit(kind, host, port, "allow", undefined, address);
    return socket;
  } catch (err) {
    const r = err instanceof Refusal ? err : new Refusal(502, "proxy error", "error");
    audit(kind, host, port, r.decision, r.body);
    throw r;
  }
}

function forwardHeaders(raw: string[], hostHeader: string): string[] {
  const named: string[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    if (raw[i]?.toLowerCase() === "connection") named.push(...(raw[i + 1] ?? "").toLowerCase().split(",").map((s) => s.trim()));
  }
  const out = ["Host", hostHeader];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i] as string;
    const lower = name.toLowerCase();
    if (!HOP_BY_HOP.has(lower) && !named.includes(lower)) out.push(name, raw[i + 1] as string);
  }
  out.push("Connection", "close");
  return out;
}

function refuse(res: http.ServerResponse, r: Refusal): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(r.status, { "content-type": "text/plain", connection: "close" }).end(r.body);
}

async function onRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let url: URL;
  try {
    url = new URL(req.url ?? "");
    if (url.protocol !== "http:" || url.username || url.password || url.port === "0") throw new Error("unsupported");
  } catch {
    audit("http", "", 0, "error", "bad request");
    return refuse(res, new Refusal(400, "absolute http:// URI required (use CONNECT for https)", "error"));
  }
  const host = bare(url.hostname);
  const port = url.port ? Number(url.port) : 80;
  let socket: net.Socket;
  try {
    socket = await open("http", host, port);
  } catch (err) {
    return refuse(res, err as Refusal);
  }
  const upstream = http.request({
    createConnection: () => socket,
    method: req.method,
    path: `${url.pathname}${url.search}`,
    headers: forwardHeaders(req.rawHeaders, url.host),
  });
  upstream.on("response", (up) => {
    const headers: string[] = [];
    for (let i = 0; i + 1 < up.rawHeaders.length; i += 2) {
      const name = up.rawHeaders[i] as string;
      if (!HOP_BY_HOP.has(name.toLowerCase())) headers.push(name, up.rawHeaders[i + 1] as string);
    }
    res.writeHead(up.statusCode ?? 502, up.statusMessage, headers);
    up.pipe(res);
    up.on("error", () => res.destroy());
  });
  upstream.on("error", () => refuse(res, new Refusal(502, "upstream error", "error")));
  res.on("close", () => upstream.destroy());
  req.pipe(upstream);
}

function rawRefusal(socket: net.Socket, r: Refusal): void {
  const body = Buffer.from(r.body);
  socket.end(
    `HTTP/1.1 ${r.status} ${http.STATUS_CODES[r.status] ?? ""}\r\nContent-Type: text/plain\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${r.body}`,
  );
}

async function onConnect(req: http.IncomingMessage, client: net.Socket, head: Buffer): Promise<void> {
  client.on("error", () => client.destroy());
  const m = AUTHORITY_RE.exec(req.url ?? "");
  const port = Number(m?.[2]);
  let host = "";
  try {
    if (!m || port < 1 || port > 65535) throw new Error("bad authority");
    host = bare(new URL(`http://${m[1]}`).hostname); // same normalisation as absolute URIs (e.g. 2130706433)
  } catch {
    audit("connect", "", 0, "error", "bad request");
    return rawRefusal(client, new Refusal(400, "CONNECT host:port required", "error"));
  }
  let upstream: net.Socket;
  try {
    upstream = await open("connect", host, port);
  } catch (err) {
    return rawRefusal(client, err as Refusal);
  }
  if (client.destroyed) {
    upstream.destroy();
    return;
  }
  client.setTimeout(IDLE_TIMEOUT_MS, () => client.destroy());
  upstream.on("error", () => client.destroy());
  client.on("close", () => upstream.destroy());
  upstream.on("close", () => client.destroy());
  client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  if (head.length) upstream.write(head);
  upstream.pipe(client);
  client.pipe(upstream);
}

const server = http.createServer((req, res) => void onRequest(req, res));
server.on("connect", (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => void onConnect(req, socket, head));
// Upgrades (e.g. WebSocket over an absolute URI) are not proxied.
server.on("upgrade", (_req: http.IncomingMessage, socket: net.Socket) => rawRefusal(socket, new Refusal(501, "upgrade not supported", "error")));
server.on("clientError", (_err, socket) => socket.destroy());
server.headersTimeout = 15_000;
server.requestTimeout = 60_000;
server.maxConnections = 1024;
server.listen(PORT, "0.0.0.0", () => console.log(JSON.stringify({ msg: "listening", port: PORT })));

for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => process.exit(0));
