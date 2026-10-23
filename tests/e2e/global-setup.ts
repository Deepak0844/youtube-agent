import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startServer } from "../support/app-server";
import { startInfra } from "../support/infra";

const run = promisify(execFile);

// The app needs the infra URLs at start, and Playwright starts `webServer` before
// globalSetup, so the server is spawned here instead. Set E2E_SKIP_BUILD=1 to reuse
// an existing `.next` build.
export default async function globalSetup(): Promise<() => Promise<void>> {
  const infra = await startInfra(); // fails fast, naming OrbStack, when Docker is down
  const port = process.env.E2E_PORT!;
  const env = { ...process.env, DATABASE_URL: infra.databaseUrl, REDIS_URL: infra.redisUrl };

  try {
    if (!process.env.E2E_SKIP_BUILD) {
      await run("npx", ["next", "build"], { env, maxBuffer: 64 * 1024 * 1024 });
    }
    // TODO(phase-1): seed the fixed owner account and fixture data; save storageState.
    const server = await startServer("npx", ["next", "start", "-H", "127.0.0.1", "-p", port], {
      env,
      url: `http://127.0.0.1:${port}/healthz`,
      timeoutMs: 60_000,
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
