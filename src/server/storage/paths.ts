import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

// Storage layout (Doc 2 §9.1). The root must be the SAME absolute path for web, worker and render-runner (it is
// bind-mounted at that path into render containers), so it is always resolved to an absolute path and never rewritten.
//
//   <root>/videos/<videoId>/                       promoted (final) files of one video
//   <root>/videos/<videoId>/attempt-<stageRunId>-<fence>/   scratch for ONE claimed attempt of one stage run
//   <root>/assets/                                 shared read-only assets
//
// The stage RUN id is part of the attempt folder because the fence counts per stage run: two runs of one video (other
// stage, or the same stage with another input_hash) can both be on fence 1. Task 11's log sink uses the same ids.

export function storageRoot(): string {
  return path.resolve(process.env.STORAGE_ROOT ?? ".data");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_PATH = 1024;
const MAX_SEGMENT = 255;

/**
 * Strict relative path check: forward slashes only, no empty / "." / ".." segments, no NUL, control characters or
 * backslashes, not absolute, no trailing slash. Returns the same string, or null. It never "fixes" a path: a path that
 * needs fixing is a path somebody crafted.
 */
export function normalizeRelPath(p: string): string | null {
  if (typeof p !== "string" || p.length === 0 || p.length > MAX_PATH) return null;
  if (/[\u0000-\u001f\u007f\\]/.test(p)) return null;
  for (const seg of p.split("/")) {
    if (seg === "" || seg === "." || seg === ".." || seg.length > MAX_SEGMENT) return null;
  }
  return p;
}

function assertAbsRoot(root: string): void {
  if (typeof root !== "string" || !path.isAbsolute(root) || root.includes("\0")) throw new Error("storage root must be an absolute path");
}

function assertVideoId(videoId: string): void {
  if (typeof videoId !== "string" || !UUID.test(videoId)) throw new Error("invalid video id");
}

function assertParts(parts: string[]): void {
  if (parts.length === 0) return;
  for (const p of parts) if (normalizeRelPath(p) === null) throw new Error("invalid path part");
}

/** `<root>/videos/<videoId>/...parts` (lexical; use safeJoin before touching disk with caller-influenced parts). */
export function videoPath(root: string, videoId: string, ...parts: string[]): string {
  assertAbsRoot(root);
  assertVideoId(videoId);
  assertParts(parts);
  return path.join(root, "videos", videoId, ...parts);
}

export function attemptDir(root: string, videoId: string, stageRunId: string, fence: number): string {
  if (typeof stageRunId !== "string" || !UUID.test(stageRunId)) throw new Error("invalid stage run id");
  if (!Number.isSafeInteger(fence) || fence < 1) throw new Error("invalid fence");
  return videoPath(root, videoId, `attempt-${stageRunId}-${fence}`);
}

function inside(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

/**
 * Joins `parts` under `root` and proves the result cannot leave it: parts must be strict relative paths (see
 * normalizeRelPath), and the deepest EXISTING ancestor of the result must resolve (symlinks followed) to a place inside
 * the real root. A dangling symlink on the way counts as existing and is followed, so it cannot be used to create a file
 * outside. Returns the lexical path under `root` as given (the root string is never rewritten).
 *
 * This is a check, not a lock: a directory swapped for a symlink after the check is not caught here. Readers therefore
 * open the final file with O_NOFOLLOW (see the media route) and writers are our own code.
 */
export async function safeJoin(root: string, ...parts: string[]): Promise<string> {
  assertAbsRoot(root);
  if (parts.length === 0) throw new Error("no path given");
  assertParts(parts);
  const lexicalRoot = path.resolve(root);
  const target = path.join(lexicalRoot, ...parts);
  if (!inside(lexicalRoot, target) || target === lexicalRoot) throw new Error("path escapes the storage root");

  const realRoot = await realpath(lexicalRoot);
  let probe = target;
  for (;;) {
    let real: string;
    try {
      await lstat(probe); // throws ENOENT when absent; a dangling symlink exists as a link and is followed next
      real = await realpath(probe);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        // A dangling symlink: lstat worked, realpath did not. Refuse: we cannot prove where it points.
        if (await lstat(probe).then(() => true, () => false)) throw new Error("path escapes the storage root");
        const up = path.dirname(probe);
        if (up === probe || !inside(lexicalRoot, up)) throw new Error("path escapes the storage root");
        probe = up;
        continue;
      }
      throw err;
    }
    if (!inside(realRoot, real)) throw new Error("path escapes the storage root");
    return target;
  }
}
