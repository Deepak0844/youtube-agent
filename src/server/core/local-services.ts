import ipaddr from "ipaddr.js";
import { classifyAddress, type AddressClass } from "@/server/core/net-policy";

// The owner's allow-list of local services (setting `network.local_services`, ADR 0003). Pure: no IO.
//
// What it is: exact `host:port` pairs for things on this machine or LAN that the owner types URLs for (Ollama, LM Studio,
// VoiceStudio). A typed URL to a private/loopback address is only reachable if its host:port is listed (safeFetch).
//
// What it is not: a way to reach the app's own services. Those ports are refused here for EVERY host spelling, and
// safeFetch still refuses own services and cloud metadata even if a row was written by hand.
//
// Bind-any addresses (0.0.0.0, ::, ::ffff:0.0.0.0) say "listen on every interface"; they are not a place you can send a
// request to, so they are refused as entries and as targets. IPv4-mapped IPv6 is refused as an entry (write the IPv4 form).

export const MAX_LOCAL_SERVICES = 20;
const MAX_INPUT_CHARS = 10_000;

/** Fixed ports of the app's own services. Deployment URLs and OWN_SERVICE_PORTS add to this; nothing removes from it. */
const FIXED_OWN_PORTS = [
  5432, // Postgres
  6379, // Redis
  8888, // SearXNG
  3128, // egress proxy
  3129, // egress proxy admin
  3000, // this app
];

function portOfUrl(raw: string | undefined, fallback?: number): number | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    if (u.port) return Number(u.port);
    return fallback;
  } catch {
    return undefined;
  }
}

export function ownServicePorts(env: Record<string, string | undefined> = process.env): Set<number> {
  const ports = new Set<number>(FIXED_OWN_PORTS);
  const add = (n: number | undefined) => {
    if (n !== undefined && Number.isInteger(n) && n >= 1 && n <= 65535) ports.add(n);
  };
  add(portOfUrl(env.DATABASE_URL, 5432));
  add(portOfUrl(env.MIGRATE_DATABASE_URL, 5432));
  add(portOfUrl(env.REDIS_URL, 6379));
  add(portOfUrl(env.SEARXNG_URL));
  add(portOfUrl(env.RENDER_RUNNER_URL));
  add(portOfUrl(env.FETCHER_URL));
  add(portOfUrl(env.EGRESS_PROXY_URL));
  for (const part of (env.OWN_SERVICE_PORTS ?? "").split(",")) {
    const p = part.trim();
    if (/^[1-9][0-9]{0,4}$/.test(p)) add(Number(p));
  }
  return ports;
}

export type EntryResult = { ok: true; entry: string; host: string; port: number } | { ok: false; reason: string };
const refuse = (reason: string): EntryResult => ({ ok: false, reason });

// Fixed sentences on purpose: a refusal never echoes what was typed.
const R = {
  shape: "Write each service as host:port, for example localhost:11434.",
  port: "The port must be a number from 1 to 65535 without leading zeros.",
  own: "That port belongs to one of this app's own services and can never be listed.",
  bindAny: "0.0.0.0 and :: mean 'every address', not a place to send requests. Use the real address, such as 127.0.0.1.",
  numeric: "Write an address as four plain numbers, like 127.0.0.1. Short, hex, octal and single-number forms are refused.",
  mapped: "IPv4-in-IPv6 forms are refused. Write the IPv4 address instead.",
  notLocal: "That address is not a private or local address, so it does not need to be listed.",
  special: "That address is reserved (metadata, link-local, multicast or unspecified) and can never be listed.",
  dns: "That is not a valid host name. Use letters, digits and hyphens with no trailing dot.",
  v6: "That is not a valid IPv6 address. Put it in square brackets, like [::1]:11434.",
} as const;

const LOCAL_CLASSES: ReadonlySet<AddressClass> = new Set(["private", "loopback", "cgnat", "docker"]);
const NUMERIC_LABEL = /^(?:0x[0-9a-f]+|[0-9]+)$/i;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function isBindAny(host: string): boolean {
  try {
    const a = ipaddr.parse(host);
    if (a.kind() === "ipv6") {
      const v6 = a as ipaddr.IPv6;
      return v6.range() === "unspecified" || (v6.isIPv4MappedAddress() && v6.toIPv4Address().toString() === "0.0.0.0");
    }
    return a.toString() === "0.0.0.0";
  } catch {
    return false;
  }
}

/** Validates one raw entry. On success `entry` is the canonical spelling that gets stored. */
export function validateLocalService(raw: string, ownPorts: ReadonlySet<number> = ownServicePorts()): EntryResult {
  if (typeof raw !== "string") return refuse(R.shape);
  const text = raw.trim();
  if (text.length === 0 || text.length > 270 || !/^[\x21-\x7e]+$/.test(text)) return refuse(R.shape);

  let hostPart: string;
  let portPart: string;
  let bracketed = false;
  const v6m = /^\[([0-9a-fA-F:.]+)\]:([0-9]+)$/.exec(text);
  if (v6m) {
    bracketed = true;
    hostPart = v6m[1]!;
    portPart = v6m[2]!;
  } else {
    const m = /^([a-zA-Z0-9.-]+):([0-9]+)$/.exec(text);
    if (!m) return refuse(R.shape);
    hostPart = m[1]!.toLowerCase();
    portPart = m[2]!;
  }

  if (!/^[1-9][0-9]{0,4}$/.test(portPart) || Number(portPart) > 65535) return refuse(R.port);
  const port = Number(portPart);

  let host: string;
  if (bracketed) {
    if (!ipaddr.IPv6.isValid(hostPart)) return refuse(R.v6);
    if (isBindAny(hostPart)) return refuse(R.bindAny);
    const v6 = ipaddr.IPv6.parse(hostPart);
    if (v6.isIPv4MappedAddress()) return refuse(R.mapped);
    if (!LOCAL_CLASSES.has(classifyAddress(hostPart))) return refuse(classifyAddress(hostPart) === "public" ? R.notLocal : R.special);
    host = `[${v6.toString()}]`;
  } else {
    const labels = hostPart.split(".");
    if (labels.some((l) => l === "")) return refuse(R.dns); // trailing dot, leading dot, empty label
    if (NUMERIC_LABEL.test(labels[labels.length - 1]!)) {
      // Anything shaped like an IPv4 address must be a canonical dotted quad: resolvers read 127.1, 0x7f000001, 0177.0.0.1 and
      // 2130706433 as 127.0.0.1, so those spellings are how a loopback/own-service target is hidden.
      if (!ipaddr.IPv4.isValidFourPartDecimal(hostPart)) return refuse(R.numeric);
      if (isBindAny(hostPart)) return refuse(R.bindAny);
      const cls = classifyAddress(hostPart);
      if (!LOCAL_CLASSES.has(cls)) return refuse(cls === "public" ? R.notLocal : R.special);
      host = hostPart;
    } else {
      if (hostPart.length > 253 || !labels.every((l) => DNS_LABEL.test(l))) return refuse(R.dns);
      host = hostPart;
    }
  }

  // After the shape checks so a malformed entry gets the more useful message. By port alone, for every host spelling:
  // `host.docker.internal:5432` and `192.168.1.5:6379` are the same service reached by another name.
  if (ownPorts.has(port)) return refuse(R.own);
  return { ok: true, entry: `${host}:${port}`, host, port };
}

export type ParseResult = { ok: true; entries: string[] } | { ok: false; errors: Array<{ line: number; reason: string }> };

/** Textarea input, one entry per line. Blank lines are skipped, duplicates collapse (first spelling wins, order kept). */
export function parseLocalServicesInput(text: string, ownPorts: ReadonlySet<number> = ownServicePorts()): ParseResult {
  if (typeof text !== "string" || text.length > MAX_INPUT_CHARS) return { ok: false, errors: [{ line: 0, reason: "That list is far too long." }] };
  const entries: string[] = [];
  const errors: Array<{ line: number; reason: string }> = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.trim() === "") return;
    const r = validateLocalService(line, ownPorts);
    if (!r.ok) errors.push({ line: i + 1, reason: r.reason });
    else if (!entries.includes(r.entry)) entries.push(r.entry);
  });
  if (errors.length > 0) return { ok: false, errors };
  if (entries.length > MAX_LOCAL_SERVICES) {
    return { ok: false, errors: [{ line: 0, reason: `At most ${MAX_LOCAL_SERVICES} services can be listed.` }] };
  }
  return { ok: true, entries };
}

/** Does the URL's exact host and port appear in the list? Invalid stored entries are ignored, never trusted. */
export function matchLocalService(list: readonly string[], url: URL, ownPorts: ReadonlySet<number> = new Set()): boolean {
  let host = url.hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
    if (!ipaddr.IPv6.isValid(host)) return false;
    host = `[${ipaddr.IPv6.parse(host).toString()}]`;
  }
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  const wanted = `${host}:${port}`;
  return list.some((raw) => {
    const r = validateLocalService(raw, ownPorts);
    return r.ok && r.entry === wanted && raw === r.entry;
  });
}
