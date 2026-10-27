// Design inspector gate (Phase 1, task 19). Run: npm run design:check
//
// Starts throwaway Postgres + Redis (same helper as the e2e suite), seeds the owner through the real setup-link path,
// then serves the app twice:
//   - a PRODUCTION build (`next start`) for the real screens, and
//   - a DEV server (`next dev`) for /dev/ui*, because those pages call notFound() in production by design (Task 17).
// Each target is opened at 1440/768/390 by the design-taste-frontend skill's inspect.mjs --app. The inspector cannot set
// cookies, so a tiny local proxy adds the owner's session cookie to every request (and none for /login, which must be
// seen signed out). Finally the skill's lint.mjs scans src/. Exit code is 1 when the inspector or linter reports a FAIL.
//
// Needs: Docker/OrbStack, Chrome, Node 22, and the skill (.claude/skills/design-taste-frontend) with a dealt app
// direction in .taste-skill/app/direction.json (never committed). Shots land in .taste-skill/app/<slug>/.
// Set DESIGN_CHECK_SKIP_BUILD=1 to reuse an existing .next build; DESIGN_CHECK_ONLY=/settings/keys,/login to narrow.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import { generateMasterKey } from "@/server/core/vault-crypto";
import { startServer, type StartedServer } from "../tests/support/app-server";
import { startInfra } from "../tests/support/infra";
import { E2E_APP_PW, seedOwner, withRole } from "../tests/e2e/global-setup";
import { STORAGE_STATE } from "../tests/e2e/fixtures/owner";

const SKILL = path.resolve(".claude/skills/design-taste-frontend/scripts");
const OUT = path.resolve(".taste-skill/app");
const TARGETS = ["/dev/ui", "/dev/ui/home", "/dev/ui/video", "/", "/settings/keys", "/settings/models", "/settings/google", "/settings/system", "/settings/audit", "/login"];
const slug = (p: string) => (p === "/" ? "home" : p.slice(1).replaceAll("/", "-"));
const only = process.env.DESIGN_CHECK_ONLY?.split(",");

// Forwards to `upstream`, adding the session cookie when given. Returns the proxy's port.
async function proxy(upstream: number, cookie: string | null): Promise<{ port: number; close: () => void }> {
  const server = http.createServer((req, res) => {
    const headers = { ...req.headers, host: `127.0.0.1:${upstream}` };
    if (cookie) headers.cookie = cookie;
    const up = http.request({ host: "127.0.0.1", port: upstream, path: req.url, method: req.method, headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on("error", () => { res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as { port: number }).port, close: () => server.close() };
}

// Async on purpose: the proxy lives in this process, so a blocking spawnSync would freeze it mid-request.
const runNode = (args: string[]) => new Promise<number>((resolve) => spawn("node", args, { stdio: "inherit" }).on("exit", (c) => resolve(c ?? 1)));

// The inspector cannot tell a Noto face from a system one, so ask Chrome which fonts really drew the Indic samples.
// Every glyph must come from a custom (self-hosted) face; a system font here means the Noto fallback chain broke.
async function indicFontCheck(url: string): Promise<boolean> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(500);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
    const { nodeIds } = await cdp.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: "[lang]:not([lang=en]):not(html)" });
    const seen = new Map<string, Set<string>>();
    let system = 0;
    for (const nodeId of nodeIds) {
      const lang = (await cdp.send("DOM.getAttributes", { nodeId })).attributes;
      const l = lang[lang.indexOf("lang") + 1] ?? "?";
      const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId }).catch(() => ({ fonts: [] }));
      for (const f of fonts) {
        if (!seen.has(l)) seen.set(l, new Set());
        seen.get(l)!.add(`${f.familyName}${f.isCustomFont ? "" : " (SYSTEM)"}`);
        if (!f.isCustomFont) system++;
      }
    }
    for (const [l, fams] of seen) console.log(`  indic ${l}: ${[...fams].join(", ")}`);
    console.log(system === 0 ? "  Indic fonts: all self-hosted Noto/Instrument faces, no system fonts." : `  FAIL Indic fonts: ${system} text run(s) drawn with a system font.`);
    return system === 0 && seen.size > 0;
  } finally {
    await browser.close();
  }
}

async function freePort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const p = (s.address() as { port: number }).port;
  await new Promise((r) => s.close(r));
  return p;
}

if (!existsSync(path.join(SKILL, "inspect.mjs"))) {
  console.error(`The design-taste-frontend skill is not installed at ${SKILL} (it is local only, .claude/ is not committed).`);
  process.exit(2);
}
const infra = await startInfra();
const stops: StartedServer[] = [];
const closers: Array<() => void> = [];
let failed = false;
try {
  const appUrl = withRole(infra.databaseUrl, "ytstudio_app", E2E_APP_PW);
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "NODE_ENV")); // `next dev` and `next build` each set their own
  const env = {
    ...base,
    DATABASE_URL: appUrl,
    REDIS_URL: infra.redisUrl,
    VAULT_MASTER_KEY: generateMasterKey(),
    RENDER_RUNNER_URL: "http://127.0.0.1:47001",
    FETCHER_URL: "http://127.0.0.1:47002",
    SEARXNG_URL: "http://127.0.0.1:48888",
    EGRESS_PROXY_URL: "http://127.0.0.1:43128",
    TRUST_PROXY: "1",
    UPLOAD_DIR: path.join(os.tmpdir(), "ytstudio-design-check-uploads"),
  } as unknown as NodeJS.ProcessEnv; // NODE_ENV is left out on purpose: `next build`/`next start`/`next dev` each set their own

  await seedOwner(infra.databaseUrl, appUrl);
  const session = JSON.parse(readFileSync(STORAGE_STATE, "utf8")).cookies[0];
  const cookie = `${session.name}=${session.value}`;

  const prodPort = await freePort();
  if (!process.env.DESIGN_CHECK_SKIP_BUILD) {
    const b = spawnSync("npx", ["next", "build"], { env, stdio: "inherit" });
    if (b.status !== 0) throw new Error("next build failed");
  }
  stops.push(await startServer("npx", ["next", "start", "-H", "127.0.0.1", "-p", String(prodPort)], { env, url: `http://127.0.0.1:${prodPort}/healthz`, timeoutMs: 60_000 }));

  const wantsDev = TARGETS.some((t) => t.startsWith("/dev/") && (!only || only.includes(t)));
  let devPort = 0;
  if (wantsDev) {
    devPort = await freePort();
    stops.push(await startServer("npx", ["next", "dev", "-H", "127.0.0.1", "-p", String(devPort)], { env, url: `http://127.0.0.1:${devPort}/healthz`, timeoutMs: 120_000 }));
  }

  for (const target of TARGETS) {
    if (only && !only.includes(target)) continue;
    const upstream = target.startsWith("/dev/") ? devPort : prodPort;
    const p = await proxy(upstream, target === "/login" ? null : cookie);
    closers.push(p.close);
    if (target.startsWith("/dev/")) await fetch(`http://127.0.0.1:${p.port}${target}`).catch(() => {}); // warm the dev compile
    console.log(`\n=== ${target} (${target.startsWith("/dev/") ? "dev server" : "production build"}) ===`);
    const code = await runNode([path.join(SKILL, "inspect.mjs"), `http://127.0.0.1:${p.port}${target}`, "--app", "--allow", "font-not-dealt", "--out", path.join(OUT, slug(target))]);
    if (code !== 0) failed = true;
    if (target === "/dev/ui" && !(await indicFontCheck(`http://127.0.0.1:${p.port}${target}`))) failed = true;
    p.close();
  }

  console.log("\n=== lint.mjs src ===");
  if ((await runNode([path.join(SKILL, "lint.mjs"), "src", "--app"])) !== 0) failed = true;
} finally {
  closers.forEach((c) => c());
  await Promise.all(stops.map((s) => s.stop()));
  await infra.stop();
}
console.log(failed ? "\ndesign:check FAILED" : "\ndesign:check passed (0 FAIL)");
process.exit(failed ? 1 : 0);
