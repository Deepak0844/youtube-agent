import path from "node:path";

// The .env that `npm run compose:up` writes for docker-compose.yml on a first run. Pure: the caller supplies the secrets and ids.
export const COMPOSE_ENV_KEYS = [
  "POSTGRES_PASSWORD",
  "YTSTUDIO_OWNER_PASSWORD",
  "YTSTUDIO_APP_PASSWORD",
  "YTSTUDIO_BACKUP_PASSWORD",
  "VAULT_MASTER_KEY",
  "HOST_STORAGE_ROOT",
  "APP_URL",
  "RENDER_IMAGE",
  "APP_UID",
  "APP_GID",
  "DOCKER_GID",
] as const;

export function renderComposeEnv(o: { hostStorageRoot: string; uid: number; gid: number; dockerGid: number; password: () => string; masterKey: () => string }): string {
  if (!path.isAbsolute(o.hostStorageRoot)) throw new Error("hostStorageRoot must be an absolute path.");
  const v: Record<(typeof COMPOSE_ENV_KEYS)[number], string> = {
    POSTGRES_PASSWORD: o.password(),
    YTSTUDIO_OWNER_PASSWORD: o.password(),
    YTSTUDIO_APP_PASSWORD: o.password(),
    YTSTUDIO_BACKUP_PASSWORD: o.password(),
    VAULT_MASTER_KEY: o.masterKey(),
    HOST_STORAGE_ROOT: o.hostStorageRoot,
    APP_URL: "http://localhost:3000",
    RENDER_IMAGE: "ytstudio-render:dev",
    APP_UID: String(o.uid),
    APP_GID: String(o.gid),
    DOCKER_GID: String(o.dockerGid),
  };
  return COMPOSE_ENV_KEYS.map((k) => `${k}=${v[k]}`).join("\n") + "\n";
}
