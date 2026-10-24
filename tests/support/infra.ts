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

const NOT_REACHABLE = "Docker engine not reachable. Start OrbStack and retry.";

// Some Docker CLIs exit 0 and print an empty or placeholder value when the daemon is unreachable,
// so success means: a non-empty, version-shaped string (digits and dots, optional suffix).
export function parseServerVersion(output: string): string {
  const v = output.trim();
  if (!/^\d+(\.\d+)+[\w.+~-]*$/.test(v)) throw new Error(NOT_REACHABLE);
  return v;
}

export async function assertDockerUp(): Promise<void> {
  let stdout: string;
  try {
    ({ stdout } = await run("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 4000 }));
  } catch {
    throw new Error(NOT_REACHABLE);
  }
  parseServerVersion(stdout);
}

export interface Infra {
  databaseUrl: string;
  redisUrl: string;
  containerIds: string[];
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
    containerIds: [postgres.getId(), redis.getId()],
    async stop() {
      await Promise.all([postgres.stop(), redis.stop()]);
    },
  };
}
