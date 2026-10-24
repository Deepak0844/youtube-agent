import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { Agent, fetch as undiciFetch } from "undici";
import { classifyAddress, type AddressClass } from "@/server/core/net-policy";

export type FetchMode = "typed" | "indirect";

export interface SafeFetchOptions {
  mode: FetchMode;
  ownServices?: Array<{ host: string; port: number }>;
  maxRedirects?: number;
  timeoutMs?: number;
  lookup?: (host: string) => Promise<string[]>;
}

export class BlockedAddressError extends Error {
  constructor(
    public readonly address: string,
    public readonly reason: AddressClass | "own-service",
  ) {
    super(`Blocked address ${address} (${reason})`);
    this.name = "BlockedAddressError";
  }
}

const TYPED_ALLOWED: ReadonlySet<AddressClass> = new Set(["public", "private", "loopback", "linklocal", "cgnat", "docker"]);
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

const defaultLookup = async (host: string): Promise<string[]> =>
  (await dnsLookup(host, { all: true })).map((r) => r.address);

function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function defaultPort(url: URL): number {
  return url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
}

function canonical(address: string): string {
  const bare = address.split("%")[0] ?? address;
  if (!ipaddr.isValid(bare)) return bare.toLowerCase();
  const parsed = ipaddr.parse(bare);
  if (parsed.kind() === "ipv6" && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
    return (parsed as ipaddr.IPv6).toIPv4Address().toString();
  }
  return parsed.toString();
}

interface OwnService {
  host: string;
  port: number;
  ips: Set<string>;
  loopback: boolean;
}

function race<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

// Resolves ownServices hosts to canonical IPs so aliases (localhost, mapped, Docker DNS) match.
async function resolveOwnServices(opts: SafeFetchOptions, signal: AbortSignal): Promise<OwnService[]> {
  return Promise.all(
    (opts.ownServices ?? []).map(async (svc) => {
      const host = stripBrackets(svc.host).toLowerCase();
      let addrs: string[] = [];
      if (isIP(host) !== 0) addrs = [host];
      else {
        try {
          addrs = await race((opts.lookup ?? defaultLookup)(host), signal);
        } catch (e) {
          if (signal.aborted) throw e;
        }
      }
      const ips = new Set(addrs.map(canonical));
      const loopback = [...ips].some((ip) => ip === "0.0.0.0" || ip === "::" || classifyAddress(ip) === "loopback");
      return { host, port: svc.port, ips, loopback };
    }),
  );
}

function check(address: string, url: URL, opts: SafeFetchOptions, own: OwnService[]): void {
  const port = defaultPort(url);
  const hostname = stripBrackets(url.hostname).toLowerCase();
  const ip = canonical(address);
  const cls = classifyAddress(address);
  for (const svc of own) {
    if (svc.port !== port) continue;
    if (svc.host === hostname || svc.ips.has(ip) || (svc.loopback && cls === "loopback")) {
      throw new BlockedAddressError(address, "own-service");
    }
  }
  const allowed = opts.mode === "typed" ? TYPED_ALLOWED.has(cls) : cls === "public";
  if (!allowed) throw new BlockedAddressError(address, cls);
}

// Validates every address the host resolves to; returns them for pinning.
async function resolveValidated(url: URL, opts: SafeFetchOptions, own: OwnService[], signal: AbortSignal): Promise<string[]> {
  const host = stripBrackets(url.hostname);
  // IP literals (URL parser already normalised decimal/hex/octal spellings) skip DNS.
  const addresses = isIP(host) !== 0 ? [host] : await race((opts.lookup ?? defaultLookup)(host), signal);
  if (addresses.length === 0) throw new Error(`No addresses for ${host}`);
  for (const address of addresses) check(address, url, opts, own);
  return addresses;
}

function pinnedAgent(addresses: string[]): Agent {
  return new Agent({
    keepAliveTimeout: 1,
    connect: {
      // Always answer with the pre-validated address: no second DNS lookup (anti-rebinding).
      // Host header and TLS servername still derive from the original hostname.
      lookup: (_host, options, cb) => {
        const wantAll = typeof options === "object" && options !== null && (options as { all?: boolean }).all;
        const list = addresses.map((address) => ({ address, family: isIP(address) }));
        if (wantAll) (cb as unknown as (e: null, a: typeof list) => void)(null, list);
        else {
          const [first] = list as [(typeof list)[number], ...typeof list];
          cb(null, first.address, first.family);
        }
      },
    },
  });
}

export async function safeFetch(url: string, init: RequestInit | undefined, options: SafeFetchOptions): Promise<Response> {
  const maxRedirects = options.maxRedirects ?? 5;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 10_000);
  const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  const own = await resolveOwnServices(options, signal);
  let current = new URL(url);
  let method = init?.method ?? "GET";
  let body = init?.body;
  let headers = new Headers(init?.headers);

  for (let hop = 0; ; hop++) {
    if (current.protocol !== "http:" && current.protocol !== "https:") {
      throw new Error(`Unsupported URL scheme ${current.protocol}`);
    }
    const addresses = await resolveValidated(current, options, own, signal);
    const agent = pinnedAgent(addresses);
    let closeNow = true;
    try {
      const res = (await undiciFetch(current, {
        ...(init as object),
        method,
        body: body as never,
        headers,
        signal,
        redirect: "manual",
        dispatcher: agent,
      })) as unknown as Response;

      const location = res.headers.get("location");
      if (!REDIRECT_STATUS.has(res.status) || location === null) {
        closeNow = false; // body still streaming; keepAliveTimeout:1 releases the socket
        return res;
      }

      await res.body?.cancel();
      if (hop >= maxRedirects) throw new Error(`Too many redirects (max ${maxRedirects})`);

      const next = new URL(location, current);
      if (next.origin !== current.origin) headers = stripCredentials(headers);
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== "GET" && method !== "HEAD")) {
        method = "GET";
        body = undefined;
      }
      current = next;
    } finally {
      if (closeNow) await agent.close().catch(() => undefined);
    }
  }
}

function stripCredentials(headers: Headers): Headers {
  const copy = new Headers(headers);
  for (const name of ["authorization", "cookie", "proxy-authorization"]) copy.delete(name);
  return copy;
}
