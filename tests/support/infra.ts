import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer } from "@testcontainers/redis";

const run = promisify(execFile);

export const POSTGRES_IMAGE = "postgres:17-alpine";
export const REDIS_IMAGE = "redis:7-alpine";

// Testcontainers does not read docker contexts; OrbStack lives at ~/.orbstack/run/docker.sock.
async function pointAtActiveContext(): Promise<void> {
  if (process.env.DOCKER_HOST) return;
  try {
    const { stdout } = await run("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], { timeout: 4000 });
    if (stdout.trim()) process.env.DOCKER_HOST = stdout.trim();
  } catch {
    // assertDockerUp reports the failure with a useful message
  }
}

export async function assertDockerUp(): Promise<void> {
  try {
    await run("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 4000 });
  } catch {
    throw new Error("Docker engine not reachable. Start OrbStack and retry.");
  }
}

export interface Infra {
  databaseUrl: string;
  redisUrl: string;
  stop(): Promise<void>;
}

export async function startInfra(): Promise<Infra> {
  await pointAtActiveContext();
  await assertDockerUp();
  const [postgres, redis] = await Promise.all([
    new PostgreSqlContainer(POSTGRES_IMAGE).start(),
    new RedisContainer(REDIS_IMAGE).start(),
  ]);
  return {
    databaseUrl: `postgres://${postgres.getUsername()}:${postgres.getPassword()}@127.0.0.1:${postgres.getMappedPort(5432)}/${postgres.getDatabase()}`,
    redisUrl: `redis://127.0.0.1:${redis.getMappedPort(6379)}`,
    async stop() {
      await Promise.all([postgres.stop(), redis.stop()]);
    },
  };
}
