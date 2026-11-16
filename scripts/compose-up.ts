import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { renderComposeEnv } from "@/server/core/compose-env";
import { generateMasterKey } from "@/server/core/vault-crypto";

// The one command: make the secrets once, then start the whole studio. Never overwrites an existing .env.
// COMPOSE_UP_DRY_RUN=1 (tests): write .env and the data folder only, start no Docker.
const envFile = path.resolve(process.env.COMPOSE_ENV_FILE ?? ".env");
const dataDir = path.resolve(process.env.COMPOSE_DATA_DIR ?? "data");
const dry = process.env.COMPOSE_UP_DRY_RUN === "1";
const RENDER_IMAGE = "ytstudio-render:dev";
const say = (s: string) => process.stdout.write(`${s}\n`);
const docker = (args: string[], inherit = false) => spawnSync("docker", args, { encoding: "utf8", stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"] });

function stop(msg: string): never {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

if (!dry && docker(["info", "--format", "{{.ServerVersion}}"]).status !== 0) stop("Docker is not running. Start Docker (or OrbStack) and run this again.");
mkdirSync(dataDir, { recursive: true });

if (!dry && docker(["image", "inspect", RENDER_IMAGE]).status !== 0) {
  say("Building the render image (first run only, a few minutes)...");
  if (docker(["build", "-f", "infra/Dockerfile.render", "-t", RENDER_IMAGE, "."], true).status !== 0) stop("The render image did not build.");
}

if (existsSync(envFile)) {
  say("Using existing .env");
} else {
  // On Linux the data folder belongs to the host user, so the app runs as that user; macOS maps ownership itself.
  const linux = process.platform === "linux" && process.getuid && process.getgid;
  // The docker socket's group as seen INSIDE a container (0 on OrbStack, the docker group on Linux): the app user needs it to start renders.
  let dockerGid = 0;
  if (!dry) {
    const g = docker(["run", "--rm", "-v", "/var/run/docker.sock:/s", "--entrypoint", "stat", RENDER_IMAGE, "-c", "%g", "/s"]);
    dockerGid = Number(g.stdout.trim());
    if (g.status !== 0 || !Number.isInteger(dockerGid)) stop("Could not read the Docker socket's group. Is /var/run/docker.sock available?");
  }
  const text = renderComposeEnv({
    hostStorageRoot: dataDir,
    uid: linux ? process.getuid!() : 10002,
    gid: linux ? process.getgid!() : 10002,
    dockerGid,
    password: () => randomBytes(24).toString("base64url"),
    masterKey: generateMasterKey,
  });
  writeFileSync(envFile, text, { mode: 0o600 });
  chmodSync(envFile, 0o600);
  say("Wrote .env with new secrets (keep it private)");
}

if (!dry) {
  const compose = (args: string[]) => docker(["compose", "--env-file", envFile, ...args], true).status ?? 1;
  if (compose(["up", "-d", "--build"]) !== 0) stop("docker compose up failed.");
  say("Setting up (the one-time owner link is printed below):");
  compose(["logs", "-f", "init"]);
  say("Open http://localhost:3000");
}
