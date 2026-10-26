import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { Agent, fetch as undiciFetch } from "undici";
import { matchLocalService, ownServicePorts } from "@/server/core/local-services";
import { classifyAddress, type AddressClass } from "@/server/core/net-policy";

export type FetchMode = "typed" | "indirect";

export interface SafeFetchOptions {
  mode: FetchMode;
  ownServices?: Array<{ host: string; port: number }>;
  /**
   * Typed mode only. The owner's `network.local_services` list (exact host:port strings). When given, a typed URL whose
   * address is private/loopback/CGNAT/Docker is allowed only if its host and port are listed; link-local is never allowed.
   * When omitted the older rule applies (any such address except own services). Own services and metadata are refused
   * either way, before the list is consulted.
   */
  localServices?: readonly string[];
  maxRedirects?: number;
  timeoutMs?: number;
  lookup?: (host: string) => Promise<string[]>;
}

export class BlockedAddressError extends Error {
  constructor(
    public readonly address: string,
    public readonly reason: AddressClass | "own-service" | "not-listed",
    detail?: string,
  ) {
    super(detail ?? `Blocked address ${address} (${reason})`);
    this.name = "BlockedAddressError";
  }
}

export type RedirectRefusal = "cross-origin-redirect-with-body" | "https-downgrade";

export class BlockedRedirectError extends Error {
  constructor(
    public readonly location: string,
    public readonly reason: RedirectRefusal,
  ) {
    super(`Refused redirect to ${location} (${reason})`);
    this.name = "BlockedRedirectError";
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

/** scheme://host:port with the URL parser's normalisation (case, IP spellings), brackets stripped, default port explicit. */
export function originKey(url: URL): string {
  return `${url.protocol}//${stripBrackets(url.hostname).toLowerCase()}:${defaultPort(url)}`;
}

/** Doc 2 §9.6: the typed policy covers only the origin the user typed; every other origin in a chain is strict. */
export function policyFor(url: URL, origin: string, mode: FetchMode): FetchMode {
  return originKey(url) === origin ? mode : "indirect";
}

// Request headers that may follow a redirect off the original origin. A body never does (see planRedirect),
// so content-type is never among them.
const CROSS_ORIGIN_HEADERS = ["accept", "accept-language", "user-agent"];

export interface RedirectStep {
  method: string;
  body: RequestInit["body"] | undefined;
  headers: Headers;
}

/** Decides the next request of a redirect chain, or refuses it. Pure: no I/O. */
export function planRedirect(from: URL, to: URL, status: number, origin: string, step: RedirectStep): RedirectStep {
  if (from.protocol === "https:" && to.protocol === "http:") throw new BlockedRedirectError(to.href, "https-downgrade");
  let { method, body, headers } = step;
  if (status === 303 || ((status === 301 || status === 302) && method !== "GET" && method !== "HEAD")) {
    method = "GET";
    body = undefined;
  }
  if (originKey(to) !== origin) {
    if (body !== undefined && body !== null) throw new BlockedRedirectError(to.href, "cross-origin-redirect-with-body");
    const kept = new Headers();
    for (const name of CROSS_ORIGIN_HEADERS) {
      const value = headers.get(name);
      if (value !== null) kept.set(name, value);
    }
    headers = kept;
  }
  return { method, body, headers };
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
  /** 0.0.0.0 / :: ("every interface"): the service answers on any local address, so every non-public address on its port is it. */
  bindAny: boolean;
}

const LOCAL_CLASSES: ReadonlySet<AddressClass> = new Set(["private", "loopback", "linklocal", "cgnat", "docker"]);
// With an allow-list, link-local is never reachable (it is where metadata services live) and only these may be listed.
const LISTABLE_CLASSES: ReadonlySet<AddressClass> = new Set(["private", "loopback", "cgnat", "docker"]);

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
        // Fail closed: an own service we cannot resolve cannot be excluded by address.
        if (addrs.length === 0) throw new BlockedAddressError(host, "own-service", `own service "${host}" did not resolve`);
      }
      const ips = new Set(addrs.map(canonical));
      const bindAny = [...ips].some((ip) => ip === "0.0.0.0" || ip === "::");
      const loopback = bindAny || [...ips].some((ip) => classifyAddress(ip) === "loopback");
      return { host, port: svc.port, ips, loopback, bindAny };
    }),
  );
}

function check(address: string, url: URL, mode: FetchMode, own: OwnService[], listed: readonly string[] | undefined): void {
  const port = defaultPort(url);
  const hostname = stripBrackets(url.hostname).toLowerCase();
  const ip = canonical(address);
  const cls = classifyAddress(address);
  for (const svc of own) {
    if (svc.port !== port) continue;
    if (svc.host === hostname || svc.ips.has(ip) || (svc.loopback && cls === "loopback") || (svc.bindAny && LOCAL_CLASSES.has(cls))) {
      throw new BlockedAddressError(address, "own-service");
    }
  }
  const allowed = mode === "typed" ? TYPED_ALLOWED.has(cls) : cls === "public";
  if (!allowed) throw new BlockedAddressError(address, cls);
  if (mode === "typed" && listed !== undefined && cls !== "public") {
    if (!LISTABLE_CLASSES.has(cls)) throw new BlockedAddressError(address, cls);
    if (!matchLocalService(listed, url, ownServicePorts())) {
      throw new BlockedAddressError(address, "not-listed", `Local address ${address} is not on the local-service list`);
    }
  }
}

// Validates every address the host resolves to; returns them for pinning.
async function resolveValidated(url: URL, mode: FetchMode, opts: SafeFetchOptions, own: OwnService[], signal: AbortSignal): Promise<string[]> {
  const host = stripBrackets(url.hostname);
  // IP literals (URL parser already normalised decimal/hex/octal spellings) skip DNS.
  const addresses = isIP(host) !== 0 ? [host] : await race((opts.lookup ?? defaultLookup)(host), signal);
  if (addresses.length === 0) throw new Error(`No addresses for ${host}`);
  for (const address of addresses) check(address, url, mode, own, opts.localServices);
  return addresses;
}

function pinnedAgent(addresses: string[], timeoutMs: number): Agent {
  return new Agent({
    keepAliveTimeout: 1,
    connect: {
      timeout: timeoutMs,
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
  const timeoutMs = options.timeoutMs ?? 10_000;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  const own = await resolveOwnServices(options, signal);
  let current = new URL(url);
  const origin = originKey(current);
  let step: RedirectStep = { method: init?.method ?? "GET", body: init?.body, headers: new Headers(init?.headers) };

  for (let hop = 0; ; hop++) {
    if (current.protocol !== "http:" && current.protocol !== "https:") {
      throw new Error(`Unsupported URL scheme ${current.protocol}`);
    }
    const addresses = await resolveValidated(current, policyFor(current, origin, options.mode), options, own, signal);
    const agent = pinnedAgent(addresses, timeoutMs);
    let closeNow = true;
    try {
      const res = (await undiciFetch(current, {
        ...(init as object),
        method: step.method,
        body: step.body as never,
        headers: step.headers,
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
      step = planRedirect(current, next, res.status, origin, step);
      current = next;
    } finally {
      // Not awaited: close() waits for a pending connect, which must not outlive the call.
      if (closeNow) void agent.close().catch(() => undefined);
    }
  }
}
