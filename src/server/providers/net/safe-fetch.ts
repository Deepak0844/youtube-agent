import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
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

function check(address: string, url: URL, opts: SafeFetchOptions): void {
  const cls = classifyAddress(address);
  const allowed = opts.mode === "typed" ? TYPED_ALLOWED.has(cls) : cls === "public";
  if (!allowed) throw new BlockedAddressError(address, cls);
  if (opts.mode === "typed") {
    const port = defaultPort(url);
    const hostname = stripBrackets(url.hostname).toLowerCase();
    for (const svc of opts.ownServices ?? []) {
      const own = svc.host.toLowerCase();
      if (svc.port === port && (own === hostname || own === address.toLowerCase())) {
        throw new BlockedAddressError(address, "own-service");
      }
    }
  }
}

// Validates every address the host resolves to; returns them for pinning.
async function resolveValidated(url: URL, opts: SafeFetchOptions): Promise<string[]> {
  const host = stripBrackets(url.hostname);
  // IP literals (URL parser already normalised decimal/hex/octal spellings) skip DNS.
  const addresses = isIP(host) !== 0 ? [host] : await (opts.lookup ?? defaultLookup)(host);
  if (addresses.length === 0) throw new Error(`No addresses for ${host}`);
  for (const address of addresses) check(address, url, opts);
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
  let current = new URL(url);
  let method = init?.method ?? "GET";
  let body = init?.body;
  let headers = new Headers(init?.headers);

  for (let hop = 0; ; hop++) {
    if (current.protocol !== "http:" && current.protocol !== "https:") {
      throw new Error(`Unsupported URL scheme ${current.protocol}`);
    }
    const addresses = await resolveValidated(current, options);
    const agent = pinnedAgent(addresses);
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
    if (!REDIRECT_STATUS.has(res.status) || location === null) return res;

    await res.body?.cancel();
    await agent.close();
    if (hop >= maxRedirects) throw new Error(`Too many redirects (max ${maxRedirects})`);

    const next = new URL(location, current);
    if (next.origin !== current.origin) headers = stripCredentials(headers);
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== "GET" && method !== "HEAD")) {
      method = "GET";
      body = undefined;
    }
    current = next;
  }
}

function stripCredentials(headers: Headers): Headers {
  const copy = new Headers(headers);
  for (const name of ["authorization", "cookie", "proxy-authorization"]) copy.delete(name);
  return copy;
}
