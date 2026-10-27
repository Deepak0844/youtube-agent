import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";

export interface StartedServer {
  stop(): Promise<void>;
}

interface Options {
  url: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  /** Also append the server output here (lets a test assert that something never reached a log). */
  logFile?: string;
}

const tail = (text: string) => text.split("\n").slice(-20).join("\n");

// Spawns a server in its own process group, resolves once `url` answers 2xx, and
// rejects at once, with the server's output, if it exits or never gets healthy.
export async function startServer(command: string, args: string[], options: Options): Promise<StartedServer> {
  const child = spawn(command, args, { env: options.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  if (options.logFile) writeFileSync(options.logFile, "");
  const keep = (d: Buffer) => {
    output += d;
    if (options.logFile) appendFileSync(options.logFile, d);
  };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);

  let exited = false;
  const exit = new Promise<never>((_, reject) =>
    child.once("exit", (code, signal) => {
      exited = true;
      reject(new Error(`${command} exited with code ${code ?? signal} before becoming healthy:\n${tail(output)}`));
    }),
  );
  exit.catch(() => {}); // handled by the race below; avoids an unhandled rejection after success

  const stop = async () => {
    if (exited || child.pid === undefined) return;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // group already gone
    }
  };

  const healthy = (async () => {
    const deadline = Date.now() + options.timeoutMs;
    while (Date.now() < deadline) {
      try {
        if ((await fetch(options.url)).ok) return;
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`${command} did not become healthy at ${options.url}:\n${tail(output)}`);
  })();

  healthy.catch(() => {}); // the loser of the race must not surface later as unhandled

  try {
    await Promise.race([healthy, exit]);
  } catch (error) {
    await stop();
    throw error;
  }
  return { stop };
}
