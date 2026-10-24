import { existsSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { docker, HARDENING } from "./docker";

const RENDER_IMAGE = "ytstudio-render:dev";

/**
 * Removes a test storage root that render jobs wrote into. Renders create out/ and bundle/ as uid 10001 with
 * mode 0755, which the runner's own uid cannot empty on a Linux bind mount (macOS virtiofs hides this). So the
 * render uid first deletes what it owns, in a throwaway locked-down container; then the host removes the rest
 * (the now-empty 10001 directories sit in runner-owned parents). Best effort: never throws.
 */
export async function removeStorageRoot(root: string | undefined): Promise<void> {
  if (!root || !existsSync(root)) return;
  const real = realpathSync(root);
  // Only ever a mkdtemp root under the temp dir: the container gets this one path, read-write.
  if (real.startsWith(realpathSync(tmpdir()) + path.sep)) {
    const children = readdirSync(real).map((n) => path.join(real, n));
    if (children.length > 0) {
      await docker(
        ["run", "--rm", "--network", "none", ...HARDENING, "--user", "10001:10001", "-v", `${real}:${real}`, "--entrypoint", "rm", RENDER_IMAGE, "-rf", "--", ...children],
        120_000,
      );
    }
  }
  try {
    rmSync(real, { recursive: true, force: true });
  } catch (err) {
    console.warn(`removeStorageRoot: could not remove ${real}: ${String(err)}`);
  }
}
