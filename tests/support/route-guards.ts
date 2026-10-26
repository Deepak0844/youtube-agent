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

const RET = String.raw`(?::[^={;]*?)?`; // optional return type annotation

/** `{ ... }` (inclusive) of a function declaration, directly after its name: `[<T>](params)[: type] {`. */
function fnDeclBody(s: string, pos: number): string | null {
  const m = /^\s*(?:<[^>(]*>)?\s*\(/.exec(s.slice(pos));
  if (!m) return null;
  return afterParams(s, pos + m[0].length - 1, false);
}

function afterParams(s: string, paren: number, arrow: boolean): string | null {
  const pend = matching(s, paren);
  if (pend < 0) return null;
  const rest = new RegExp(`^\\s*${RET}\\s*${arrow ? "=>\\s*" : ""}\\{`).exec(s.slice(pend + 1));
  if (!rest) return null; // expression-bodied arrow or something odd: require an inline block
  const open = pend + 1 + rest[0].length - 1;
  const close = matching(s, open);
  return close < 0 ? null : s.slice(open, close + 1);
}

/** Body of what follows `NAME =`. ONLY these shapes are analysable: `async? function (…) {`, `async? (…) => {`,
 *  `async? ident => {`. An alias or call (`= h;`, `= withAuth(…)`) returns null and the caller FAILS the file. */
function constBody(s: string, pos: number): string | null {
  const t = s.slice(pos);
  const fn = /^\s*(?:async\s+)?function\b[^(]*\(/.exec(t);
  if (fn) return afterParams(s, pos + fn[0].length - 1, false);
  const ar = /^\s*(?:async\s+)?\(/.exec(t);
  if (ar) return afterParams(s, pos + ar[0].length - 1, true);
  const id = /^\s*(?:async\s+)?\w+\s*=>\s*\{/.exec(t);
  if (id) {
    const open = pos + id[0].length - 1;
    const close = matching(s, open);
    return close < 0 ? null : s.slice(open, close + 1);
  }
  return null;
}

function declBody(s: string, local: string): string | null {
  const f = new RegExp(`(?<![.\\w])(?:async\\s+)?function\\s+${local}\\b`).exec(s);
  if (f) return fnDeclBody(s, f.index + f[0].length);
  const c = new RegExp(`(?<![.\\w])(?:const|let|var)\\s+${local}\\s*(?::[^=]+)?=`).exec(s);
  return c ? constBody(s, c.index + c[0].length) : null;
}

export interface Handler {
  name: string;
  body: string | null;
}
/** Exported HTTP handlers of a route file, plus structural problems (re-exports, unanalysable forms). */
export function exportedHandlers(blanked: string): { handlers: Handler[]; problems: string[] } {
  const handlers: Handler[] = [];
  const problems: string[] = [];
  const add = (name: string, body: string | null) => {
    handlers.push({ name, body });
  };
  for (const m of blanked.matchAll(/\bexport\s+(?:async\s+)?function\s+(\w+)/g)) {
    if (METHODS.includes(m[1]!)) add(m[1]!, fnDeclBody(blanked, m.index + m[0].length));
  }
  for (const m of blanked.matchAll(/\bexport\s+(?:const|let|var)\s+(\w+)\s*(?::[^=]+)?=/g)) {
    if (METHODS.includes(m[1]!)) add(m[1]!, constBody(blanked, m.index + m[0].length));
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

const depthOf = (text: string): number => [...text].reduce((d, ch) => d + (ch === "{" ? 1 : ch === "}" ? -1 : 0), 0);

/** Text before a guard may only declare variables: no call/await except `new URL(<x>.url)`, no assignments or mutations. */
function preludeProblem(before: string): string | null {
  const cleaned = before.replace(/new\s+URL\s*\(\s*\w+\.url\s*\)/g, "URL_OK").replace(/\b(?:const|let|var)\s+\w+\s*=\s*$/, "");
  if (/\bawait\b|\(|\bdelete\b|\+\+|--|\bnew\b|\byield\b/.test(cleaned)) return "work (a call, await or mutation) happens before the guard";
  if (/\b(return|throw)\b/.test(cleaned)) return "a return/throw comes before the guard";
  for (const stmt of cleaned.split(/[;\n]/).map((x) => x.trim()).filter(Boolean)) {
    if (!/^(?:const|let|var)\b/.test(stmt) && !/^[\w\s,:{}[\]]*$/.test(stmt)) return "a non-declaration statement comes before the guard";
    if (!/^(?:const|let|var)\b/.test(stmt) && /=/.test(stmt)) return "an assignment comes before the guard";
  }
  return null;
}

/** Common position rule: the first `call` match must be at depth 0 of the body, preceded by declarations only. */
function guardPosition(inner: string, call: RegExp): { idx: number } | { problem: string } {
  const m = call.exec(inner);
  if (!m) return { problem: "guard call not found" };
  const before = inner.slice(0, m.index);
  if (depthOf(before) !== 0) return { problem: "guard is nested inside a block (if/else/loop/callback/function), not at the top of the body" };
  const bad = preludeProblem(before);
  return bad ? { problem: bad } : { idx: m.index };
}

/** Guard rule for one handler body: `const x = await requireOwnerApi(` at the top level of the body, only declarations
 *  before it, and the very next statement returns x when it is a Response. Helpers are not followed (keep it inline). */
export function handlerGuarded(body: string | null): string | null {
  if (!body) return "handler cannot be analysed (alias, wrapped or expression-bodied handlers are not accepted; use `async function`/arrow with a block body)";
  const inner = body.slice(1, -1);
  const m = /(?:const|let)\s+(\w+)\s*=\s*await\s+requireOwnerApi\s*\(/.exec(inner);
  if (!m) return "no `const x = await requireOwnerApi(`";
  const pos = guardPosition(inner, /(?:const|let)\s+\w+\s*=\s*await\s+requireOwnerApi\s*\(/);
  if ("problem" in pos) return pos.problem;
  const open = inner.indexOf("(", m.index + m[0].length - 1);
  const end = matching(inner, open);
  const name = m[1]!;
  const tail = inner.slice(end + 1);
  if (!new RegExp(`^\\s*;?\\s*if\\s*\\(\\s*${name}\\s+instanceof\\s+Response\\s*\\)\\s*(?:\\{\\s*)?return\\s+${name}\\s*;?`).test(tail)) {
    return `the statement after requireOwnerApi must be \`if (${name} instanceof Response) return ${name}\``;
  }
  return null;
}

const OWNER_CALL = /\bawait\s+requireOwner\s*\(/;
function componentGuarded(body: string): string | null {
  const inner = body.slice(1, -1);
  if (!OWNER_CALL.test(inner)) return "no `await requireOwner(`";
  const pos = guardPosition(inner, OWNER_CALL);
  return "problem" in pos ? pos.problem : null;
}

function defaultComponentBody(b: string): string | null {
  const direct = /\bexport\s+default\s+(?:async\s+)?function\b\s*\w*/.exec(b);
  if (direct) return fnDeclBody(b, direct.index + direct[0].length);
  const ref = /\bexport\s+default\s+(\w+)\s*;?/.exec(b);
  return ref ? declBody(b, ref[1]!) : null;
}

/** Page rule: `await requireOwner(` first thing, at the top of the default component, or of a same-file component it
 *  renders/calls (cookies() must sit inside <Suspense> under cacheComponents, so the real `/` page guards in an inner one). */
function pageGuarded(b: string): string | null {
  const body = defaultComponentBody(b);
  if (!body) return "default export of the page cannot be analysed";
  if (OWNER_CALL.test(body)) return componentGuarded(body);
  for (const m of b.matchAll(/(?<![.\w])(?:async\s+)?function\s+([A-Z]\w*)/g)) {
    const inner = fnDeclBody(b, m.index + m[0].length);
    if (inner && OWNER_CALL.test(inner) && new RegExp(`<${m[1]}[\\s/>]|\\b${m[1]}\\s*\\(`).test(body)) return componentGuarded(inner);
  }
  return "default component does not `await requireOwner(` (directly or via a component it renders); keep the guarded component in the same file";
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
    if (o.isPublic) {
      const own = ["/api/v1", "/api/webhooks", "/api/oauth"].some((p) => o.url === p || o.url.startsWith(p + "/"));
      const need = own ? "assertAllowedHost" : "assertSameOrigin";
      for (const h of handlers.filter((x) => ["POST", "PUT", "PATCH", "DELETE"].includes(x.name))) {
        const inner = h.body?.slice(1, -1) ?? "";
        const m = new RegExp(`\\b${need}\\s*\\(`).exec(inner);
        if (!m || depthOf(inner.slice(0, m.index)) !== 0) out.push(`${h.name}: public state-changing handler must call ${need}( at the top level`);
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
    const body = m[1] ? fnDeclBody(b, m.index + m[0].length) : constBody(b, m.index + m[0].length);
    const why = body ? componentGuarded(body) : "cannot be analysed (use a block body)";
    if (why) out.push(`server action ${name}: ${why}`);
  }
  return out;
}
