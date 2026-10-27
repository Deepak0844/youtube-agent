import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isPublicPath } from "@/lib/auth/policy";
import { ACTION_ALLOW, checkActionFile, checkRoute, METADATA_FILES, ROUTE_FILE, SOURCE_EXT, SPECIAL_FILES } from "../support/route-guards";

const APP = path.resolve("src/app");
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
// Route groups "(x)" vanish from the URL; dynamic "[x]" segments become a placeholder.
function urlOf(file: string): string {
  const segs = path.relative(APP, path.dirname(file)).split(path.sep).filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith("@"));
  return "/" + segs.map((s) => (s.startsWith("[") ? "x" : s)).join("/");
}
const files = walk(path.resolve("src")).filter((f) => SOURCE_EXT.test(f));
const routes = files.filter((f) => f.startsWith(APP) && ROUTE_FILE.test(f));
const actionFiles = files.filter((f) => /["']use server["']/.test(readFileSync(f, "utf8")));

describe("route inventory (real files)", () => {
  it("finds the known routes and actions", () => {
    expect(routes.length).toBeGreaterThanOrEqual(8);
    expect(actionFiles.length).toBeGreaterThanOrEqual(3);
  });
  it("the live feed route exists, needs a session, and checks it before opening the stream", () => {
    const events = routes.find((f) => urlOf(f) === "/api/events");
    expect(events, "src/app/api/events/route.ts").toBeDefined();
    expect(isPublicPath("/api/events")).toBe(false);
    const src = readFileSync(events!, "utf8");
    expect(src.indexOf("requireOwnerApi(")).toBeGreaterThan(-1);
    expect(src.indexOf("requireOwnerApi(")).toBeLessThan(src.indexOf("createEventStream("));
    expect(src.indexOf("assertAllowedHost(request)")).toBeGreaterThan(-1);
  });
  it.each(routes.map((f) => [urlOf(f), f]))("%s is public or properly guarded", (url, file) => {
    const v = checkRoute({ url: url!, file: file!, src: readFileSync(file!, "utf8"), isPublic: isPublicPath(url!) });
    expect(v, `${file}`).toEqual([]);
  });
  it.each(actionFiles)("server actions in %s authenticate", (file) => {
    expect(checkActionFile(readFileSync(file, "utf8")), file).toEqual([]);
  });
  it("special and metadata files are exactly the expected set and never public by accident", () => {
    const found = files
      .filter((f) => f.startsWith(APP))
      .map((f) => ({ f, base: path.basename(f).replace(SOURCE_EXT, "") }))
      .filter(({ base }) => SPECIAL_FILES.includes(base) || METADATA_FILES.includes(base));
    expect(found.map(({ f }) => path.relative(APP, f)).sort()).toEqual(["(app)/layout.tsx", "(app)/settings/layout.tsx", "layout.tsx"].map((p) => p.split("/").join(path.sep))); // a new special file must be reviewed here
    for (const { f, base } of found.filter(({ base }) => METADATA_FILES.includes(base))) {
      expect(isPublicPath(urlOf(f) + "/" + base), `${f} would be public`).toBe(false);
    }
  });
  it("exemption lists are what we expect", () => {
    expect(SPECIAL_FILES).toEqual(["layout", "default", "not-found", "error", "loading", "global-error", "template"]);
    expect(METADATA_FILES).toEqual(["sitemap", "robots", "opengraph-image", "icon", "manifest"]);
  });
  it("only the three public actions are exempt", () => expect(ACTION_ALLOW).toEqual(["loginAction", "setupAction", "logoutAction"]));
  it("uses proxy.ts, never middleware", () => {
    expect(existsSync("src/proxy.ts")).toBe(true);
    for (const f of ["src/middleware.ts", "src/middleware.js", "middleware.ts", "middleware.js"]) expect(existsSync(f)).toBe(false);
  });
  it("proxy.ts imports the shared policy and excludes the documented paths", () => {
    const src = readFileSync("src/proxy.ts", "utf8");
    expect(src).toContain("@/lib/auth/policy");
    for (const p of ["api/uploads", "api/media", "api/webhooks", "api/events", "api/oauth", "_next/static", "_next/image", "favicon"]) expect(src).toContain(p);
  });
});

describe("checkers (synthetic sources)", () => {
  const route = (src: string, url = "/api/x") => checkRoute({ url, file: "src/app/api/x/route.ts", src, isPublic: false });
  const page = (src: string, file = "src/app/x/page.tsx") => checkRoute({ url: "/x", file, src, isPublic: false });
  const G = "const o = await requireOwnerApi(r); if (o instanceof Response) return o;";
  it("recognises every source extension", () => {
    for (const f of ["a/page.jsx", "a/page.js", "a/route.mjs", "a/route.cjs", "a/page.tsx"]) expect(ROUTE_FILE.test(f), f).toBe(true);
    expect(ROUTE_FILE.test("a/pager.tsx")).toBe(false);
  });

  describe("pages", () => {
    it("a .jsx page without a guard fails; comment/string/template mentions fail", () => {
      expect(page("export default function P(){return null}", "src/app/x/page.jsx")).not.toEqual([]);
      expect(page("// await requireOwner()\nexport default function P(){}")).not.toEqual([]);
      expect(page('export default function P(){ const s = "await requireOwner()"; return s }')).not.toEqual([]);
      expect(page("export default function P(){ return `await requireOwner()` }")).not.toEqual([]);
    });
    it("direct guard, guard in a rendered inner component, and `export default Name` pass", () => {
      expect(page("export default async function P(){ await requireOwner(); }")).toEqual([]);
      expect(page("export default function P(){ return <S><Inner/></S> }\nasync function Inner(){ await requireOwner(); return 1 }")).toEqual([]);
      expect(page("async function P(){ await requireOwner(); }\nexport default P;")).toEqual([]);
    });
    it("work or nesting before the page guard fails", () => {
      expect(page("export default async function P(){ await db.q(); await requireOwner(); }")).not.toEqual([]);
      expect(page("export default async function P(){ if (x) { await requireOwner(); } }")).not.toEqual([]);
      expect(page("export default async function P(){ items.forEach(async () => { await requireOwner(); }) }")).not.toEqual([]);
      expect(page("export default function P(){ return <I/> }\nasync function I(){ const d = await load(); await requireOwner(); }")).not.toEqual([]);
      expect(page("export default async function P({ params }){ const p = params; await requireOwner(); }")).toEqual([]);
    });
    it("a guard in a component that is never rendered fails", () => {
      expect(page("export default function P(){ return null }\nasync function Inner(){ await requireOwner() }")).not.toEqual([]);
    });
    it("a public page needs none", () => {
      expect(checkRoute({ url: "/login", file: "src/app/login/page.tsx", src: "", isPublic: true })).toEqual([]);
    });
  });

  describe("routes", () => {
    it("proper multi-method file passes, in every export form", () => {
      expect(route(`export async function GET(r){ ${G} return Response.json({}) }\nexport async function POST(r){ ${G} return Response.json({}) }`)).toEqual([]);
      expect(route(`export const GET = async (r) => { ${G} return 1 };\nexport const DELETE = async function(r){ ${G} return 1 };`)).toEqual([]);
      expect(route(`async function GET(r){ ${G} }\nfunction POST(r){ ${G} }\nexport { GET, POST };`)).toEqual([]);
      expect(route(`export function GET(r){ const g = await requireOwnerApi(r);\n if (g instanceof Response) { return g; } }`)).toEqual([]);
    });
    it("GET guarded + POST (or any other method) unguarded fails", () => {
      for (const m of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
        const v = route(`export async function GET(r){ ${G} }\nexport async function ${m}(r){ return Response.json({}) }`);
        expect(v.join(), m).toContain(m);
      }
      expect(route(`async function GET(r){ ${G} }\nasync function POST(r){ return 1 }\nexport { GET, POST }`)).not.toEqual([]);
    });
    it("arrow handlers: guarded passes, unguarded fails, expression body fails", () => {
      expect(route(`export const GET = async (r) => { ${G} return 1 }`)).toEqual([]);
      expect(route("export const GET = async (r) => { return Response.json({}) }")).not.toEqual([]);
      expect(route("export const GET = async (r) => Response.json({})")).not.toEqual([]);
      expect(route("export const GET = handler;")).not.toEqual([]);
    });
    it("a guard hidden in a string, template literal, comment fails", () => {
      expect(route('export async function GET(r){ const s = "const o = await requireOwnerApi(r); if (o instanceof Response) return o;"; return 1 }')).not.toEqual([]);
      expect(route("export async function GET(r){ const s = `const o = await requireOwnerApi(r); if (o instanceof Response) return o;`; return 1 }")).not.toEqual([]);
      expect(route(`export async function GET(r){ /* ${G} */ return 1 }`)).not.toEqual([]);
    });
    it("a guard in an unreachable or nested block fails", () => {
      for (const c of ["false", "0", "null", "undefined", "cond"]) {
        expect(route(`export async function GET(r){ if (${c}) { ${G} } return 1 }`), c).not.toEqual([]);
      }
    });
    it("a guard after a return fails", () => {
      expect(route(`export async function GET(r){ return Response.json({}); ${G} }`)).not.toEqual([]);
      expect(route(`export async function GET(r){ if (x) return 1; ${G} }`)).not.toEqual([]);
    });
    it("a helper that is never called, or called instead of an inline guard, fails", () => {
      expect(route(`async function helper(r){ ${G} }\nexport async function GET(r){ return 1 }`)).not.toEqual([]);
      expect(route(`async function helper(r){ ${G} return o }\nexport async function GET(r){ await helper(r); return 1 }`)).not.toEqual([]); // keep the guard inline
    });
    it("ignoring the guard result fails", () => {
      expect(route("export async function GET(r){ await requireOwnerApi(r); return 1 }")).not.toEqual([]);
      expect(route("export async function GET(r){ const o = await requireOwnerApi(r); return 1 }")).not.toEqual([]);
      expect(route("export async function GET(r){ const o = await requireOwnerApi(r); if (o instanceof Response) return Response.json({}); return o }")).not.toEqual([]);
    });
    it("an alias or wrapped handler is not analysable and never borrows another handler's body", () => {
      expect(route(`const h = x;\nexport const GET = h;\nexport async function POST(r){ ${G} }`).join()).toContain("GET");
      expect(route(`const GET = h;\nexport { GET };\nexport async function POST(r){ ${G} }`).join()).toContain("GET");
      expect(route(`export const GET = withAuth(async (r) => { ${G} });`)).not.toEqual([]);
      expect(route(`export const GET = async r => { ${G} }`)).toEqual([]);
      expect(route(`export const GET = async function named(r) { ${G} }`)).toEqual([]);
      expect(route(`export async function GET(r: Request): Promise<Response> { ${G} }`)).toEqual([]);
    });
    it("work before the guard fails; only declarations and new URL(request.url) may precede it", () => {
      expect(route(`export async function GET(r){ await db.query(); ${G} }`)).not.toEqual([]);
      expect(route(`export async function GET(r){ await db.delete(); ${G} }`)).not.toEqual([]);
      expect(route(`export async function GET(r){ const x = readStuff(); ${G} }`)).not.toEqual([]);
      expect(route(`export async function GET(r){ counter++; ${G} }`)).not.toEqual([]);
      expect(route(`export async function GET(r){ state = 1; ${G} }`)).not.toEqual([]);
      expect(route(`export async function GET(r){ const url = new URL(r.url); ${G} return url }`)).toEqual([]);
      expect(route(`export async function GET(r){ const { a } = r; ${G} }`)).toEqual([]);
      expect(route(`export async function GET(r){ ${G} await db.query() }`)).toEqual([]);
    });
    it("public state-changing handlers call assertSameOrigin (or assertAllowedHost for token/signature routes) at the top level", () => {
      const pub = (url: string, src: string) => checkRoute({ url, file: "src/app/x/route.ts", src, isPublic: true });
      expect(pub("/api/auth/login", "export async function POST(r){ return 1 }")).not.toEqual([]);
      expect(pub("/api/auth/login", "export async function POST(r){ const b = assertSameOrigin(r); if (b) return b }")).toEqual([]);
      expect(pub("/api/auth/login", "export async function POST(r){ if (x) { assertSameOrigin(r) } }")).not.toEqual([]);
      expect(pub("/api/auth/login", "export async function GET(r){ return 1 }")).toEqual([]);
      expect(pub("/api/v1/x", "export async function POST(r){ return 1 }")).not.toEqual([]);
      expect(pub("/api/v1/x", "export async function POST(r){ assertAllowedHost(r) }")).toEqual([]);
      expect(pub("/api/webhooks/s", "export async function POST(r){ assertAllowedHost(r) }")).toEqual([]);
      expect(pub("/api/oauth/cb", "export async function POST(r){ assertSameOrigin(r) }")).not.toEqual([]);
    });
    it("re-exports cannot be checked and fail", () => {
      expect(route('export { GET } from "./other"')).not.toEqual([]);
      expect(route('export * from "./other"')).not.toEqual([]);
      expect(route(`export async function GET(r){ ${G} }\nexport * from "./other"`)).not.toEqual([]);
      expect(route("export const dynamic = 'force-dynamic'")).not.toEqual([]); // no handler at all
    });
    it("routes the proxy skips must call the host/origin guard in every handler", () => {
      const pub = (url: string, src: string) => checkRoute({ url, file: "src/app/api/media/route.ts", src, isPublic: true });
      for (const url of ["/api/uploads", "/api/media/x", "/api/webhooks/stripe", "/api/events", "/api/oauth/callback"]) {
        expect(pub(url, "export function GET(){ return 1 }"), url).not.toEqual([]);
        expect(pub(url, "export function GET(r){ const e = assertAllowedHost(r); return e }"), url).toEqual([]);
        expect(pub(url, "export function GET(r){ const e = assertSameOrigin(r); return e }"), url).toEqual([]);
        expect(pub(url, "export function GET(r){ assertAllowedHost(r) }\nexport function POST(){ return 1 }"), url).not.toEqual([]);
        expect(pub(url, 'export function GET(){ const s = "assertAllowedHost(r)" }'), url).not.toEqual([]);
      }
      expect(pub("/api/v1/x", "export function GET(){ return 1 }")).toEqual([]);
    });
  });

  describe("server actions", () => {
    const head = '"use server";\n';
    it("must call requireOwner unless allow-listed", () => {
      expect(checkActionFile(head + "export async function deleteAll(){ await db.q() }")).not.toEqual([]);
      expect(checkActionFile(head + "export async function deleteAll(){ await requireOwner(); await db.q() }")).toEqual([]);
      expect(checkActionFile(head + "export const del = async () => { await db.q() }")).not.toEqual([]);
      expect(checkActionFile(head + "export async function loginAction(){}\nexport async function logoutAction(){}")).toEqual([]);
      expect(checkActionFile(head + "export async function loginAction(){}\nexport async function other(){ if (x) { y() } }")).not.toEqual([]);
    });
    it("rejects export lists, default, star, class, let, var, and inline directives", () => {
      expect(checkActionFile(head + "async function a(){}\nexport { a }")).not.toEqual([]);
      expect(checkActionFile(head + "export default async function a(){}")).not.toEqual([]);
      expect(checkActionFile(head + 'export * from "./x"')).not.toEqual([]);
      expect(checkActionFile(head + "export class K {}")).not.toEqual([]);
      expect(checkActionFile(head + "export let f = async () => { await db.q() }")).not.toEqual([]);
      expect(checkActionFile(head + "export var f = async () => { await db.q() }")).not.toEqual([]);
      expect(checkActionFile("export async function f(){ 'use server'; await db.q() }")).not.toEqual([]);
      expect(checkActionFile("export function plain(){}")).toEqual([]);
    });
    it("the guard must be the first call and at the top of the action body", () => {
      expect(checkActionFile(head + "export async function a(){ await db.q(); await requireOwner(); }")).not.toEqual([]);
      expect(checkActionFile(head + "export async function a(){ if (x) { await requireOwner(); } }")).not.toEqual([]);
      expect(checkActionFile(head + "export async function a(){ await requireOwner(); await db.q(); }")).toEqual([]);
    });
    it("a requireOwner mention in a string or comment does not count", () => {
      expect(checkActionFile(head + 'export async function f(){ const s = "requireOwner("; }')).not.toEqual([]);
      expect(checkActionFile(head + "export async function f(){ /* requireOwner() */ }")).not.toEqual([]);
    });
  });
});

// The signed media route is public on purpose: its credential is an HMAC in the URL. The generic guard checker cannot
// tell "public and checked" from "public and forgotten", so this one pins what that route must do, in order.
function checkSignedRoute(src: string): string[] {
  const out: string[] = [];
  const host = src.search(/\bassertAllowedHost\s*\(/);
  const verify = src.search(/\bverifyMediaUrl\s*\(/);
  const io = src.search(/\b(safeJoin|createReadStream|readFile|open|stat|lstat|realpath|access)\s*\(/);
  if (host < 0) out.push("no assertAllowedHost( call");
  const pre = src.search(/\bprecheckMediaUrl\s*\(/);
  const keyRead = src.search(/\bget(Cached)?MediaKey\s*\(/);
  if (verify < 0) out.push("no verifyMediaUrl( call");
  if (pre < 0) out.push("no precheckMediaUrl( call");
  if (pre >= 0 && keyRead >= 0 && keyRead < pre) out.push("reads the signing key before precheckMediaUrl(");
  if (verify >= 0 && io >= 0 && io < verify) out.push("touches the filesystem before verifyMediaUrl(");
  if (host >= 0 && verify >= 0 && verify < host) out.push("verifies before the Host check");
  if (/\b(readSessionCookie|requireOwner(Api)?|cookies)\b/.test(src)) out.push("reads a session: the signature must be the only credential");
  if (/console\.\w+\([^)]*(request\.url|\.search|searchParams)/.test(src)) out.push("logs the URL or query string");
  const exported = [...src.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map((m) => m[1]).sort();
  if (exported.join() !== "GET,HEAD") out.push(`exports ${exported.join() || "nothing"}; expected exactly GET,HEAD`);
  return out;
}

describe("signed media route", () => {
  const file = "src/app/api/media/[...path]/route.ts";
  it("is listed public in the policy", () => {
    expect(isPublicPath("/api/media/videos/a/b.mp4")).toBe(true);
    expect(isPublicPath("/api/mediax")).toBe(false);
  });
  it("route_is_listed_public_in_policy_and_has_a_signature_check", () => {
    expect(existsSync(file)).toBe(true);
    expect(checkSignedRoute(readFileSync(file, "utf8")), file).toEqual([]);
  });
  it("the checker itself catches the mistakes it exists for", () => {
    const ok = "export async function GET(r){ assertAllowedHost(r); precheckMediaUrl(a); getCachedMediaKey(d); verifyMediaUrl(a,b,c); await open(p) }\nexport async function HEAD(r){ assertAllowedHost(r); precheckMediaUrl(a); verifyMediaUrl(a,b,c) }";
    expect(checkSignedRoute(ok)).toEqual([]);
    expect(checkSignedRoute(ok.replace("verifyMediaUrl(a,b,c); await open(p)", "await open(p); verifyMediaUrl(a,b,c)"))).not.toEqual([]);
    expect(checkSignedRoute(ok.replace("precheckMediaUrl(a); getCachedMediaKey(d);", "getCachedMediaKey(d); precheckMediaUrl(a);"))).not.toEqual([]);
    expect(checkSignedRoute(ok.replace(/precheckMediaUrl\(a\); /g, ""))).not.toEqual([]);
    expect(checkSignedRoute(ok.replace(/verifyMediaUrl\(a,b,c\); /g, ""))).not.toEqual([]);
    expect(checkSignedRoute(ok.replace(/assertAllowedHost\(r\); /g, ""))).not.toEqual([]);
    expect(checkSignedRoute(ok + "\nexport async function POST(r){}")).not.toEqual([]);
    expect(checkSignedRoute("const c = readSessionCookie(r);\n" + ok)).not.toEqual([]);
    expect(checkSignedRoute(ok + "\nconsole.error(request.url)")).not.toEqual([]);
  });
});
