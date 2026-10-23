import { execFileSync } from "node:child_process";
import pg from "pg";
import { Redis } from "ioredis";
import { describe, expect, it } from "vitest";
import { assertDockerUp, startInfra } from "../support/infra";

describe("test infrastructure", () => {
  it("starts postgres and redis on random loopback ports and removes them", async () => {
    const infra = await startInfra();
    try {
      expect(infra.containerIds).toHaveLength(2);

      const client = new pg.Client({ connectionString: infra.databaseUrl });
      await client.connect();
      const { rows } = await client.query("SELECT 1 AS one");
      expect(rows[0].one).toBe(1);
      await client.end();

      const redis = new Redis(infra.redisUrl);
      expect(await redis.ping()).toBe("PONG");
      redis.disconnect();
    } finally {
      await infra.stop();
    }
    for (const id of infra.containerIds) {
      const left = execFileSync("docker", ["ps", "-aq", "--filter", `id=${id}`]).toString().trim();
      expect(left, `container ${id} still exists`).toBe("");
    }
  });

  it("fails fast naming OrbStack when no daemon is reachable", async () => {
    const saved = process.env.DOCKER_HOST;
    process.env.DOCKER_HOST = "unix:///nonexistent/docker.sock";
    const started = Date.now();
    try {
      await expect(assertDockerUp()).rejects.toThrow(
        "Docker engine not reachable. Start OrbStack and retry.",
      );
    } finally {
      if (saved === undefined) delete process.env.DOCKER_HOST;
      else process.env.DOCKER_HOST = saved;
    }
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
