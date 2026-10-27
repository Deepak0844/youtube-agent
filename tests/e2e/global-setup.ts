import os from "node:os";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { generateMasterKey } from "@/server/core/vault-crypto";
import { login } from "@/server/db/auth";
import { consumeSetupLink, createSetupLink } from "@/server/db/owner";
import { createPool } from "@/server/db/pool";
import { SESSION_COOKIE, SESSION_MAX_AGE_S } from "@/lib/auth/session-cookie";
import { startServer } from "../support/app-server";
import { startInfra } from "../support/infra";
import { OWNER_PASSWORD, OWNER_USERNAME, SEED_IP, STORAGE_STATE } from "./fixtures/owner";

const run = promisify(execFile);
const E2E_OWNER_PW = "e2e-owner-pw";
export const E2E_APP_PW = "e2e-app-pw";

export function withRole(url: string, user: string, password: string): string {
  const u = new URL(url);
  u.username = user;
  u.password = password;
  return u.toString();
}

// The app needs the infra URLs at start, and Playwright starts `webServer` before globalSetup, so the server is spawned
// here instead. Set E2E_SKIP_BUILD=1 to reuse an existing `.next` build.
//
// E2E server environment (documented decisions):
//  - TRUST_PROXY=1: tests play the reverse proxy by sending `x-forwarded-for` with a unique address per spec, so lockouts
//    of one spec never lock another (all test traffic is really 127.0.0.1). The app takes the RIGHTMOST entry.
//  - AUTH_MAX_IN_FLIGHT=1: makes the `busy` (503) path reachable. Playwright therefore runs with workers: 1.
export default async function globalSetup(): Promise<() => Promise<void>> {
  const infra = await startInfra(); // fails fast, naming OrbStack, when Docker is down
  const port = process.env.E2E_PORT!;
  // The server runs as the least-privilege app role; migrations run as the owner (see migrate-cli.mts).
  const appUrl = withRole(infra.databaseUrl, "ytstudio_app", E2E_APP_PW);
  const vaultKey = generateMasterKey(); // throwaway key for the throwaway database (settings/keys page)
  process.env.E2E_VAULT_MASTER_KEY = vaultKey; // workers inherit it so specs can seed real ciphertext
  const env = {
    ...process.env,
    DATABASE_URL: appUrl,
    REDIS_URL: infra.redisUrl,
    VAULT_MASTER_KEY: vaultKey,
    // The production server refuses every local-service entry until it knows the app's own service ports (S2).
    RENDER_RUNNER_URL: "http://127.0.0.1:47001",
    FETCHER_URL: "http://127.0.0.1:47002",
    SEARXNG_URL: "http://127.0.0.1:48888",
    EGRESS_PROXY_URL: "http://127.0.0.1:43128",
    TRUST_PROXY: "1",
    AUTH_MAX_IN_FLIGHT: "1",
    UPLOAD_MAX_BYTES: String(50 * 1024 * 1024), // lets the oversize test stay small
    UPLOAD_DIR: path.join(os.tmpdir(), `ytstudio-e2e-uploads-${port}`),
  };
  process.env.E2E_SERVER_LOG = path.join(os.tmpdir(), `ytstudio-e2e-server-${port}.log`);
  process.env.E2E_DATABASE_URL = appUrl; // workers inherit it (tests/e2e/fixtures/sessions.ts)

  try {
    if (!process.env.E2E_SKIP_BUILD) {
      await run("npx", ["next", "build"], { env, maxBuffer: 64 * 1024 * 1024 });
    }
    await seedOwner(infra.databaseUrl, appUrl);
    const server = await startServer("npx", ["next", "start", "-H", "127.0.0.1", "-p", port], {
      env,
      url: `http://127.0.0.1:${port}/healthz`,
      timeoutMs: 60_000,
      logFile: process.env.E2E_SERVER_LOG,
    });
    return async () => {
      await server.stop();
      await infra.stop();
    };
  } catch (error) {
    await infra.stop();
    throw error;
  }
}

// Migrate, create the fixed owner through the real setup-link path, log in once through the real login() and save the
// session as a Playwright storageState for the ui-* projects.
export async function seedOwner(superUrl: string, appUrl: string): Promise<void> {
  const pool = createPool(appUrl);
  try {
    await run("npx", ["tsx", "tests/e2e/fixtures/migrate-cli.mts"], {
      env: {
        ...process.env,
        BOOTSTRAP_DATABASE_URL: superUrl,
        MIGRATE_DATABASE_URL: withRole(superUrl, "ytstudio_owner", E2E_OWNER_PW),
        YTSTUDIO_OWNER_PASSWORD: E2E_OWNER_PW,
        YTSTUDIO_APP_PASSWORD: E2E_APP_PW,
      },
    });
    const link = await createSetupLink(pool, "create", "http://127.0.0.1");
    const consumed = await consumeSetupLink(pool, link.slice(link.lastIndexOf("/") + 1), { username: OWNER_USERNAME, password: OWNER_PASSWORD });
    if (!consumed.ok) throw new Error(`e2e owner seeding failed: ${consumed.reason}`);
    const session = await login(pool, { username: OWNER_USERNAME, password: OWNER_PASSWORD, ip: SEED_IP, userAgent: "e2e-seed" });
    if (!session.ok) throw new Error(`e2e owner login failed: ${session.reason}`);
    await mkdir(path.dirname(STORAGE_STATE), { recursive: true });
    await writeFile(
      STORAGE_STATE,
      JSON.stringify({
        cookies: [
          {
            name: SESSION_COOKIE,
            value: session.token,
            domain: "127.0.0.1",
            path: "/",
            expires: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_S,
            httpOnly: true,
            secure: false,
            sameSite: "Lax",
          },
        ],
        origins: [],
      }),
      { mode: 0o600 },
    );
  } finally {
    await pool.end();
  }
}
