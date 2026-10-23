import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { startServer } from "../support/app-server";

describe("startServer", () => {
  it("rejects fast with exit code and output when the process dies", async () => {
    const started = Date.now();
    await expect(
      startServer("node", ["-e", "console.error('port in use'); process.exit(3)"], {
        url: "http://127.0.0.1:1/healthz",
        timeoutMs: 30_000,
      }),
    ).rejects.toThrow(/exited with code 3[\s\S]*port in use/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("rejects with the output tail when it never becomes healthy", async () => {
    await expect(
      startServer("node", ["-e", "console.log('booting'); setInterval(() => {}, 1000)"], {
        url: "http://127.0.0.1:1/healthz",
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow(/did not become healthy[\s\S]*booting/);
  });

  it("resolves when healthy, and stop() is safe to call twice", async () => {
    const probe = createServer((_, res) => res.end("ok"));
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const { port } = probe.address() as { port: number };
    const server = await startServer("node", ["-e", "setInterval(() => {}, 1000)"], {
      url: `http://127.0.0.1:${port}/`,
      timeoutMs: 5_000,
    });
    await server.stop();
    await expect(server.stop()).resolves.toBeUndefined();
    probe.close();
  });
});
