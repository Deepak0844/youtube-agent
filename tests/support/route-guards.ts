// Pure "lint-style" checkers shared by tests/unit/route-inventory.test.ts and its self-tests. They read source text only.
export const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
export const ROUTE_FILE = /(^|[\\/])(page|route)\.(ts|tsx|js|jsx|mjs|cjs)$/;
// Paths the proxy matcher skips entirely: the Host guard does not run there, so handlers must call it themselves.
export const PROXY_EXCLUDED = ["/api/uploads", "/api/media", "/api/webhooks", "/api/events", "/api/oauth"];
export const ACTION_ALLOW = ["loginAction", "setupAction", "logoutAction"];

export const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** Guard check for a page.* or route.* file. Returns violations (empty = ok). */
export function checkRoute(o: { url: string; file: string; src: string; isPublic: boolean }): string[] {
  const src = stripComments(o.src);
  const out: string[] = [];
  const isRoute = /(^|[\\/])route\.[a-z]+$/.test(o.file);
  if (!o.isPublic) {
    if (isRoute) {
      const m = /(?:const|let)\s+(\w+)\s*=\s*await\s+requireOwnerApi\s*\(/.exec(src);
      const name = m?.[1];
      if (!name) out.push("route is not public and does not `const x = await requireOwnerApi(`");
      else if (!new RegExp(`if\\s*\\(\\s*${name}\\s+instanceof\\s+Response\\s*\\)\\s*(?:\\{\\s*)?return\\s+${name}\\b`).test(src)) {
        out.push(`result of requireOwnerApi (${name}) is not returned when it is a Response`);
      }
    } else if (!/await\s+requireOwner\s*\(/.test(src)) {
      out.push("page is not public and does not `await requireOwner(`");
    }
  }
  if (isRoute && PROXY_EXCLUDED.some((p) => o.url === p || o.url.startsWith(p + "/")) && !/\b(assertAllowedHost|assertSameOrigin)\s*\(/.test(src)) {
    out.push("route is excluded from the proxy but never calls assertAllowedHost/assertSameOrigin");
  }
  return out;
}

function bodyOf(src: string, from: number): string {
  const start = src.indexOf("{", from);
  if (start < 0) return "";
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  return src.slice(start);
}

/** Server Action files: every exported function must call requireOwner( unless it is on the named allow-list. */
export function checkActionFile(srcRaw: string): string[] {
  const src = stripComments(srcRaw);
  const out: string[] = [];
  const leading = /^\s*(["'])use server\1/.test(src);
  if (!leading) {
    if (/["']use server["']/.test(src)) out.push('inline "use server" is not allowed; use a file-level directive');
    return out;
  }
  if (/\bexport\s+default\b/.test(src) || /\bexport\s*\{/.test(src)) out.push("use `export function`/`export const` only in a use-server file");
  const re = /\bexport\s+(?:async\s+)?function\s+(\w+)|\bexport\s+const\s+(\w+)\s*=/g;
  for (let m; (m = re.exec(src)); ) {
    const name = (m[1] ?? m[2])!;
    if (ACTION_ALLOW.includes(name)) continue;
    if (!/\brequireOwner\s*\(/.test(bodyOf(src, m.index + m[0].length))) out.push(`server action ${name} does not call requireOwner(`);
  }
  return out;
}
