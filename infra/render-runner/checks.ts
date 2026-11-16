import { timingSafeEqual } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

// SECURITY CONTROL: the front door of the render service. Three small checks, each failing closed: who may call, how much we read,
// and which folders a job may name. No dependencies beyond node: so they can be read in one sitting.

/** `Authorization: Bearer <token>` with exactly the configured token. Constant-time compare; an empty configured token authorises nobody. */
export function authorized(header: string | undefined, token: string): boolean {
  if (token === "" || typeof header !== "string") return false;
  const m = /^Bearer (\S+)$/.exec(header);
  if (!m) return false;
  const given = Buffer.from(m[1]!);
  const want = Buffer.from(token);
  if (given.length !== want.length) {
    timingSafeEqual(want, want); // same work either way
    return false;
  }
  return timingSafeEqual(given, want);
}

/** Reads a request body, stopping as soon as it passes `maxBytes`: the rest is never pulled. */
export async function readBody(req: AsyncIterable<Buffer | Uint8Array>, maxBytes = 8192): Promise<Buffer> {
  const parts: Buffer[] = [];
  let n = 0;
  for await (const chunk of req) {
    const b = Buffer.from(chunk);
    n += b.length;
    if (n > maxBytes) throw new Error("body too large");
    parts.push(b);
  }
  return Buffer.concat(parts);
}

const NOT_ALLOWED = "render folder not allowed";
const MOUNT_SAFE = /^[^:,\0\r\n]+$/; // the same rule as every other mount source (render-job.ts): it ends up in `docker run -v`

/**
 * The two folders of a job, as real directories inside the storage root: no symlink at any step (the real path must be exactly the
 * root joined with the relative path), no `..`, nothing that could add mount options. Returns the paths inside this container and the
 * host paths the Docker daemon will see. Every failure is the same fixed sentence: nothing about the filesystem leaks.
 */
export async function resolveJobDirs(job: { inDir: string; outDir: string }, root: string, hostRoot: string): Promise<{ inDir: string; outDir: string; hostIn: string; hostOut: string }> {
  if (!path.isAbsolute(hostRoot) || path.normalize(hostRoot) !== hostRoot || !MOUNT_SAFE.test(hostRoot)) throw new Error(NOT_ALLOWED);
  const realRoot = await realpath(root).catch(() => { throw new Error(NOT_ALLOWED); });
  const one = async (rel: string): Promise<{ abs: string; host: string }> => {
    if (typeof rel !== "string" || rel === "" || rel === "." || !MOUNT_SAFE.test(rel) || path.isAbsolute(rel) || path.posix.normalize(rel) !== rel || rel.split("/").some((s) => s === ".." || s === "")) throw new Error(NOT_ALLOWED);
    const abs = path.join(realRoot, rel);
    const st = await lstat(abs).catch(() => null);
    if (!st || !st.isDirectory() || st.isSymbolicLink()) throw new Error(NOT_ALLOWED);
    if ((await realpath(abs).catch(() => "")) !== abs) throw new Error(NOT_ALLOWED); // a symlink somewhere on the way
    return { abs, host: path.posix.join(hostRoot, rel) };
  };
  const i = await one(job.inDir);
  const o = await one(job.outDir);
  return { inDir: i.abs, outDir: o.abs, hostIn: i.host, hostOut: o.host };
}
