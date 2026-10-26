// ONE source of truth for who may reach what without a session. Pure (no Next, no IO): used by src/proxy.ts, the route
// handlers, and the unit tests (auth-policy, route-inventory). Fail closed: anything odd is "not public" / "not allowed".

// ---- Host allow-list -------------------------------------------------------------------------------------------------
export const DEFAULT_ALLOWED_HOSTS = "localhost,127.0.0.1,[::1]";

/** "[::1]" and "::1" both mean the IPv6 loopback; entries are stored as bare lowercase hostnames, no port, no trailing dot. */
function bareHost(h: string): string {
  let s = h.trim().toLowerCase();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  return s.endsWith(".") ? s.slice(0, -1) : s;
}

export function parseAllowedHosts(env: string | undefined): string[] {
  return (env ?? DEFAULT_ALLOWED_HOSTS)
    .split(",")
    .map(bareHost)
    .filter((h) => h.length > 0);
}

const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.?$/;
const BRACKET_V6 = /^\[([0-9a-f:.]+)\](?::(\d{1,5}))?$/;
const NAME_PORT = /^([^:\[\]]+)(?::(\d{1,5}))?$/;

/** Exact match on the hostname (never a suffix/prefix), after lowercasing, stripping the port and one trailing dot. */
export function isAllowedHost(hostHeader: string | null | undefined, allowed: readonly string[]): boolean {
  if (typeof hostHeader !== "string" || hostHeader.length === 0 || hostHeader.length > 255) return false;
  const h = hostHeader.toLowerCase();
  let name: string;
  let port: string | undefined;
  const v6 = BRACKET_V6.exec(h);
  if (v6) {
    name = v6[1]!;
    port = v6[2];
    if (!name.includes(":")) return false;
  } else {
    const m = NAME_PORT.exec(h);
    if (!m) return false;
    name = m[1]!;
    port = m[2];
    if (!HOSTNAME.test(name)) return false; // rejects userinfo (@), paths, spaces, control chars, commas
  }
  if (port !== undefined && Number(port) > 65535) return false;
  return allowed.includes(bareHost(name));
}

// ---- Public (no session) routes --------------------------------------------------------------------------------------
export interface PublicRoute {
  path: string;
  /** exact: only this path. prefix: this path and anything below it on a segment boundary ("/login-admin" is NOT below "/login"). */
  match: "exact" | "prefix";
}
export const PUBLIC_ROUTES: readonly PublicRoute[] = [
  { path: "/login", match: "exact" },
  { path: "/setup", match: "prefix" },
  { path: "/healthz", match: "exact" },
  { path: "/readyz", match: "exact" },
  { path: "/api/auth/login", match: "exact" }, // JSON login; does its own origin, lockout and admission checks
  { path: "/api/media", match: "prefix" }, // signed URL (Phase 3)
  { path: "/api/webhooks", match: "prefix" },
  { path: "/api/oauth", match: "prefix" }, // OAuth callback
  { path: "/api/v1", match: "prefix" }, // API token (Phase 2)
];

/**
 * Canonical path used for every policy decision: query/hash dropped, percent-decoded ONCE, then "//", "." and ".." resolved.
 * Case is kept (Next routes are case-sensitive, so "/Login" is not "/login" and falls to "needs a session").
 * Returns null for anything undecodable or containing control characters / backslashes: callers must treat null as protected.
 */
export function normalizePath(raw: string): string | null {
  if (typeof raw !== "string" || !raw.startsWith("/") || raw.length > 4096) return null;
  const cut = raw.search(/[?#]/);
  const pathOnly = cut >= 0 ? raw.slice(0, cut) : raw;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathOnly);
  } catch {
    return null;
  }
  if (/[\u0000-\u001f\u007f\\]/.test(decoded)) return null;
  const out: string[] = [];
  for (const seg of decoded.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return "/" + out.join("/");
}

export function isPublicPath(raw: string): boolean {
  const p = normalizePath(raw);
  if (p === null) return false;
  return PUBLIC_ROUTES.some((r) => (r.match === "exact" ? p === r.path : p === r.path || p.startsWith(r.path + "/")));
}

export const isApiPath = (raw: string): boolean => {
  const p = normalizePath(raw);
  return p !== null && (p === "/api" || p.startsWith("/api/"));
};

// ---- Post-login redirect target --------------------------------------------------------------------------------------
/** Same-site relative path only: starts with exactly one "/", no backslash, no control chars, <= 2048 chars. Else "/". */
export function safeNext(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return "/";
  if (raw[0] !== "/" || raw[1] === "/" || raw[1] === "\\") return "/";
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return "/";
  const firstSlash = raw.indexOf("/");
  const colon = raw.indexOf(":");
  if (colon >= 0 && colon < firstSlash) return "/"; // unreachable after the leading-slash rule; kept as a belt-and-braces check
  return raw;
}
