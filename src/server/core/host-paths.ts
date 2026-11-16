import path from "node:path";
import { KnownFailure } from "@/server/core/paid-call";

// When the worker runs in a container, its folders (/data/...) do not exist for the host's Docker daemon, which
// resolves `docker run -v` sources. The worker is told the host-side path of its storage root and rewrites the prefix.
export type HostPathMap = { from: string; to: string };

/** null = the worker runs on the host: paths are already host paths. */
export function hostPathFor(p: string, map: HostPathMap | null): string {
  if (map === null) return p;
  if (p !== map.from && !p.startsWith(map.from + path.sep)) {
    throw new KnownFailure("A render folder is outside the storage root and cannot be mounted.");
  }
  return map.to + p.slice(map.from.length);
}

export function hostPathMapFrom(env: Record<string, string | undefined>, storageRoot: string): HostPathMap | null {
  const to = env["HOST_STORAGE_ROOT"];
  if (to === undefined || to === "") return null;
  if (!path.isAbsolute(to) || path.normalize(to) !== to) throw new Error("HOST_STORAGE_ROOT must be an absolute path.");
  // Same rule as every other mount source (remotion-container.ts MOUNT_SAFE): it ends up in `docker run -v <path>:/in:ro`.
  if (!/^[^:,\0\r\n]+$/.test(to)) throw new Error("HOST_STORAGE_ROOT cannot be mounted safely (no colon, comma or line break).");
  return { from: storageRoot, to };
}
