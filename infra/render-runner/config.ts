import path from "node:path";
import { renderImageName } from "../../src/server/render/runner";

// What the service needs to start, read from its environment. Missing or unusable values stop it with one clear line: it never starts half-configured.
export interface RunnerConfig {
  token: string;
  image: string;
  hostRoot: string;
  root: string;
  port: number;
}

const MOUNT_SAFE = /^[^:,\0\r\n]+$/;

export function loadRunnerConfig(env: Record<string, string | undefined>): { ok: true; config: RunnerConfig } | { ok: false; error: string } {
  const need = (key: string): string | null => {
    const v = env[key]?.trim();
    return v ? v : null;
  };
  const token = need("RENDER_RUNNER_TOKEN");
  if (token === null) return { ok: false, error: "RENDER_RUNNER_TOKEN is not set." };
  if (!/^[A-Za-z0-9_-]{16,}$/.test(token)) return { ok: false, error: "RENDER_RUNNER_TOKEN may only use letters, digits, - and _ (at least 16 characters)." };
  const image = need("RENDER_IMAGE");
  if (image === null) return { ok: false, error: "RENDER_IMAGE is not set." };
  try {
    renderImageName({ RENDER_IMAGE: image });
  } catch {
    return { ok: false, error: "RENDER_IMAGE is not a valid image reference." };
  }
  const hostRoot = need("HOST_STORAGE_ROOT");
  if (hostRoot === null) return { ok: false, error: "HOST_STORAGE_ROOT is not set." };
  if (!path.isAbsolute(hostRoot) || path.normalize(hostRoot) !== hostRoot || !MOUNT_SAFE.test(hostRoot)) return { ok: false, error: "HOST_STORAGE_ROOT must be an absolute path without colon, comma or line break." };
  const portText = need("PORT");
  const port = portText === null ? 4100 : Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: "PORT is not a valid port." };
  return { ok: true, config: { token, image, hostRoot, root: need("STORAGE_ROOT") ?? "/data", port } };
}
