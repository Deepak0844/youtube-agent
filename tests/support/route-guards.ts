// Pure "lint-style" checkers shared by tests/unit/route-inventory.test.ts and its self-tests. They read source text only.
// All analysis runs on a "blanked" copy of the source (comments, strings and template literals replaced by spaces, same
// length) so a guard hidden in text or a comment never counts and offsets stay valid.
export const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
export const ROUTE_FILE = /(^|[\\/])(page|route)\.(ts|tsx|js|jsx|mjs|cjs)$/;
// Paths the proxy matcher skips entirely: the Host guard does not run there, so handlers must call it themselves.
export const PROXY_EXCLUDED = ["/api/uploads", "/api/media", "/api/webhooks", "/api/events", "/api/oauth"];
export const ACTION_ALLOW = ["loginAction", "setupAction", "logoutAction"];
export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
/** Route files allowed to re-export handlers from another module (`export { GET } from`, `export * from`). Empty on purpose. */
export const REEXPORT_ALLOW: string[] = [];
// Next special files / metadata routes that are not page|route files. Inventory test asserts the exact set found.
export const SPECIAL_FILES = ["layout", "default", "not-found", "error", "loading", "global-error", "template"];
export const METADATA_FILES = ["sitemap", "robots", "opengraph-image", "icon", "manifest"];

/** Replaces comments (and, unless keepStrings, string/template contents) with spaces; newlines and length are kept. */
export function blank(src: string, keepStrings = false): string {
  let out = "";
  for (let i = 0; i < src.length; ) {
    const c = src[i]!;
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") {
        out += " ";
        i++;
      }
    } else if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      const stop = Math.min(j + 1, src.length);
      const lit = src.slice(i, stop);
      out += keepStrings ? lit : c + lit.slice(1, -1).replace(/[^\n]/g, " ") + (lit.length > 1 ? c : "");
      i = stop;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}
export const stripComments = (src: string): string => blank(src, true);

function matching(s: string, open: number): number {
  const o = s[open]!;
  const close = o === "(" ? ")" : o === "{" ? "}" : "]";
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === o) depth++;
    else if (s[i] === close && --depth === 0) return i;
  }
  return -1;
}

/** Body text `{ ... }` (inclusive) of a function whose declaration head ends at `from`; null if not analysable. */
function bodyAfterHead(s: string, from: number): string | null {
  const paren = s.indexOf("(", from);
  if (paren < 0) return null;
  const pend = matching(s, paren);
  if (pend < 0) return null;
  const rest = /^\s*(?::[^={;]*?)?\s*(=>\s*)?\{/.exec(s.slice(pend + 1));
  if (!rest) return null; // expression-bodied arrow or something odd: require an inline block
  const open = pend + 1 + rest[0].length - 1;
  const close = matching(s, open);
  return close < 0 ? null : s.slice(open, close + 1);
}

function declBody(s: string, local: string): string | null {
  const f = new RegExp(`(?<![.\\w])(?:async\\s+)?function\\s+${local}\\b`).exec(s);
  if (f) return bodyAfterHead(s, f.index + f[0].length);
  const c = new RegExp(`(?<![.\\w])(?:const|let|var)\\s+${local}\\s*=\\s*(?:async\\s+)?(?:function\\b[^(]*)?`).exec(s);
  return c ? bodyAfterHead(s, c.index + c[0].length) : null;
}

export interface Handler {
  name: string;
  body: string | null;
}
/** Exported HTTP handlers of a route file, plus structural problems (re-exports, unanalysable forms). */
export function exportedHandlers(blanked: string): { handlers: Handler[]; problems: string[] } {
  const handlers: Handler[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  const add = (name: string, body: string | null) => {
    seen.add(name);
    handlers.push({ name, body });
  };
  for (const m of blanked.matchAll(/\bexport\s+(?:async\s+)?function\s+(\w+)/g)) {
    if (METHODS.includes(m[1]!)) add(m[1]!, bodyAfterHead(blanked, m.index + m[0].length));
  }
  for (const m of blanked.matchAll(/\bexport\s+(?:const|let|var)\s+(\w+)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b[^(]*)?/g)) {
    if (METHODS.includes(m[1]!)) add(m[1]!, bodyAfterHead(blanked, m.index + m[0].length));
  }
  for (const m of blanked.matchAll(/\bexport\s*\{([^}]*)\}\s*(from\b)?/g)) {
    if (m[2]) {
      problems.push("re-export from another module (`export { } from`) cannot be checked");
      continue;
    }
    for (const part of m[1]!.split(",")) {
      const [local, exported = local] = part.trim().split(/\s+as\s+/);
      if (local && METHODS.includes(exported!.trim())) add(exported!.trim(), declBody(blanked, local.trim()));
    }
  }
  if (/\bexport\s*\*/.test(blanked)) problems.push("`export *` cannot be checked");
  if (handlers.length === 0) problems.push("route exports no HTTP handler");
  return { handlers, problems };
}

/** Guard rule for one handler body: `const x = await requireOwnerApi(` at the top level of the body, nothing returned
 *  before it, and the very next statement returns x when it is a Response. A guard in a helper the handler calls is NOT
 *  accepted (keep it inline). */
export function handlerGuarded(body: string | null): string | null {
  if (!body) return "handler body cannot be analysed (use a block body)";
  const inner = body.slice(1, -1);
  const m = /(?:const|let)\s+(\w+)\s*=\s*await\s+requireOwnerApi\s*\(/.exec(inner);
  if (!m) return "no `const x = await requireOwnerApi(`";
  const before = inner.slice(0, m.index);
  const depth = [...before].reduce((d, ch) => d + (ch === "{" ? 1 : ch === "}" ? -1 : 0), 0);
  if (depth !== 0) return "guard is nested inside a block (if/else/loop/function), not at the top of the handler";
  if (/\b(return|throw)\b/.test(before)) return "a return/throw comes before the guard";
  const open = inner.indexOf("(", m.index + m[0].length - 1);
  const end = matching(inner, open);
  const name = m[1]!;
  const tail = inner.slice(end + 1);
  if (!new RegExp(`^\\s*;?\\s*if\\s*\\(\\s*${name}\\s+instanceof\\s+Response\\s*\\)\\s*(?:\\{\\s*)?return\\s+${name}\\s*;?`).test(tail)) {
    return `the statement after requireOwnerApi must be \`if (${name} instanceof Response) return ${name}\``;
  }
  return null;
}

function defaultComponentBody(b: string): string | null {
  const direct = /\bexport\s+default\s+(?:async\s+)?function\b\s*\w*/.exec(b);
  if (direct) return bodyAfterHead(b, direct.index + direct[0].length);
  const ref = /\bexport\s+default\s+(\w+)\s*;?/.exec(b);
  return ref ? declBody(b, ref[1]!) : null;
}

/** Page rule: `await requireOwner(` in the default component, or in a component of the same file that the default
 *  component renders (`<Name`) or calls; needed because cookies() must sit inside <Suspense> under cacheComponents. */
function pageGuarded(b: string): string | null {
  const body = defaultComponentBody(b);
  if (!body) return "default export of the page cannot be analysed";
  if (/\bawait\s+requireOwner\s*\(/.test(body)) return null;
  for (const m of b.matchAll(/(?<![.\w])(?:async\s+)?function\s+([A-Z]\w*)/g)) {
    const inner = bodyAfterHead(b, m.index + m[0].length);
    if (inner && /\bawait\s+requireOwner\s*\(/.test(inner) && new RegExp(`<${m[1]}[\\s/>]|\\b${m[1]}\\s*\\(`).test(body)) return null;
  }
  return "default component does not `await requireOwner(` (directly or via a component it renders)";
}

/** Guard check for a page.* or route.* file. Returns violations (empty = ok). */
export function checkRoute(o: { url: string; file: string; src: string; isPublic: boolean }): string[] {
  const b = blank(o.src);
  const out: string[] = [];
  const isRoute = /(^|[\\/])route\.[a-z]+$/.test(o.file);
  if (isRoute) {
    const { handlers, problems } = exportedHandlers(b);
    const allowed = REEXPORT_ALLOW.includes(o.file);
    if (!allowed) out.push(...problems);
    if (!o.isPublic) {
      for (const h of handlers) {
        const why = handlerGuarded(h.body);
        if (why) out.push(`${h.name}: ${why}`);
      }
    }
    if (PROXY_EXCLUDED.some((p) => o.url === p || o.url.startsWith(p + "/"))) {
      for (const h of handlers) {
        if (!h.body || !/\b(assertAllowedHost|assertSameOrigin)\s*\(/.test(h.body)) out.push(`${h.name}: route is excluded from the proxy but the handler never calls assertAllowedHost/assertSameOrigin`);
      }
    }
  } else if (!o.isPublic) {
    const why = pageGuarded(b);
    if (why) out.push(why);
  }
  return out;
}

/** Server Action files: every exported function-like thing must call requireOwner( unless allow-listed. */
export function checkActionFile(srcRaw: string): string[] {
  const out: string[] = [];
  const leading = /^\s*(["'])use server\1/.test(stripComments(srcRaw));
  const b = blank(srcRaw);
  if (!leading) {
    if (/["']use server["']/.test(stripComments(srcRaw))) out.push('inline "use server" is not allowed; use a file-level directive');
    return out;
  }
  if (/\bexport\s+default\b/.test(b) || /\bexport\s*\{/.test(b) || /\bexport\s*\*/.test(b)) out.push("use `export function`/`export const` only in a use-server file");
  if (/\bexport\s+(?:abstract\s+)?class\b/.test(b)) out.push("`export class` is not allowed in a use-server file");
  const re = /\bexport\s+(?:async\s+)?function\s+(\w+)|\bexport\s+(?:const|let|var)\s+(\w+)\s*=/g;
  for (let m; (m = re.exec(b)); ) {
    const name = (m[1] ?? m[2])!;
    if (ACTION_ALLOW.includes(name)) continue;
    const start = b.indexOf("{", m.index + m[0].length);
    const body = start < 0 ? "" : b.slice(start, matching(b, start) + 1 || undefined);
    if (!/\brequireOwner\s*\(/.test(body)) out.push(`server action ${name} does not call requireOwner(`);
  }
  return out;
}
