import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { startInfra } from "../support/infra";

const run = promisify(execFile);

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`App did not become healthy at ${url}`);
}

// The app needs the infra URLs at start, and Playwright starts `webServer` before
// globalSetup, so the server is spawned here instead.
export default async function globalSetup(): Promise<() => Promise<void>> {
  const infra = await startInfra(); // fails fast, naming OrbStack, when Docker is down
  const port = process.env.E2E_PORT!;
  const env = { ...process.env, DATABASE_URL: infra.databaseUrl, REDIS_URL: infra.redisUrl };

  if (!process.env.E2E_SKIP_BUILD) {
    await run("npx", ["next", "build"], { env, maxBuffer: 64 * 1024 * 1024 });
  }
  const server = spawn("npx", ["next", "start", "-H", "127.0.0.1", "-p", port], {
    env,
    stdio: "ignore",
    detached: true,
  });

  // TODO(phase-1): seed the fixed owner account and fixture data; save storageState.

  try {
    await waitForHealth(`http://127.0.0.1:${port}/healthz`, 60_000);
  } catch (error) {
    process.kill(-server.pid!, "SIGTERM");
    await infra.stop();
    throw error;
  }

  return async () => {
    process.kill(-server.pid!, "SIGTERM");
    await infra.stop();
  };
}
