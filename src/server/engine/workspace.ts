import { createHash } from "node:crypto";
import { chmod, cp, lstat, mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

// The locked per-video folder of an engine run (ADR 0015). Claude Code starts INSIDE `work/` (its starting folder is the only
// one it may read; everything above, like the tools config in `dir`, is denied). Skills are read-only copies in
// `work/.claude/skills` and brand files, libraries and example shorts in `work/ref/` (Edit is denied there too). (Claude Code keeps the real HOME: it needs it to find the
// owner's login, ADR 0014; its Read rules still keep it out of the home folder.) After every run,
// checkAfterRun compares two snapshots of the whole folder: anything changed outside `work/`, any link, any change under
// `work/ref/`, or a work folder over the limits fails the run. Links are reported, never followed.

export const WORK_LIMITS = { maxBytes: 200 * 1024 * 1024, maxFiles: 5000 } as const;
const HASH_MAX = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface Entry {
  type: "file" | "dir" | "link" | "other";
  size: number;
  mtimeMs: number;
  /** sha256 of files up to 1 MB; bigger files are compared by size and time. */
  hash?: string;
}
export interface Snapshot {
  entries: ReadonlyMap<string, Entry>;
  workBytes: number;
  workFiles: number;
}
export interface Workspace {
  dir: string;
  workDir: string;
  snapshot(): Promise<Snapshot>;
}
export interface WorkspaceSeeds {
  /** Copied to work/.claude/skills (read-only). */
  skillsDir?: string;
  /** Each copied to work/ref/<to> (read-only). */
  refDirs?: ReadonlyArray<{ from: string; to: string }>;
}

async function readOnlyFiles(dir: string): Promise<void> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await readOnlyFiles(p);
    else if (e.isFile()) await chmod(p, 0o444);
  }
}

async function walk(dir: string, rel: string, out: Map<string, Entry>): Promise<void> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const r = rel ? `${rel}/${e.name}` : e.name;
    const st = await lstat(p);
    if (st.isSymbolicLink()) out.set(r, { type: "link", size: 0, mtimeMs: st.mtimeMs });
    else if (st.isDirectory()) {
      out.set(r, { type: "dir", size: 0, mtimeMs: 0 });
      await walk(p, r, out);
    } else if (st.isFile()) {
      const hash = st.size <= HASH_MAX ? createHash("sha256").update(await readFile(p)).digest("hex") : undefined;
      out.set(r, { type: "file", size: st.size, mtimeMs: st.mtimeMs, ...(hash ? { hash } : {}) });
    } else out.set(r, { type: "other", size: 0, mtimeMs: st.mtimeMs });
  }
}

async function takeSnapshot(dir: string): Promise<Snapshot> {
  const entries = new Map<string, Entry>();
  await walk(dir, "", entries);
  let workBytes = 0;
  let workFiles = 0;
  for (const [r, e] of entries) {
    if (!r.startsWith("work/") || e.type === "dir") continue;
    workFiles += 1;
    workBytes += e.size;
  }
  return { entries, workBytes, workFiles };
}

/** Creates (or re-creates, empty) the run folder of one video and copies the seeds in, read-only. */
export async function prepareWorkspace(root: string, videoId: string, seeds: WorkspaceSeeds = {}): Promise<Workspace> {
  if (!UUID.test(videoId)) throw new Error("engine workspace: bad video id");
  const dir = path.join(root, "videos", videoId, "engine");
  await rm(dir, { recursive: true, force: true });
  const workDir = path.join(dir, "work");
  await mkdir(workDir, { recursive: true });
  if (seeds.skillsDir) {
    const to = path.join(workDir, ".claude", "skills");
    await cp(seeds.skillsDir, to, { recursive: true, dereference: false, verbatimSymlinks: true });
    await readOnlyFiles(to);
  }
  for (const r of seeds.refDirs ?? []) {
    if (!/^[a-z0-9][a-z0-9_-]{0,40}$/.test(r.to)) throw new Error("engine workspace: bad reference folder name");
    const to = path.join(workDir, "ref", r.to);
    await cp(r.from, to, { recursive: true, dereference: false, verbatimSymlinks: true });
    await readOnlyFiles(to);
  }
  return { dir, workDir, snapshot: () => takeSnapshot(dir) };
}

const same = (a: Entry | undefined, b: Entry | undefined): boolean =>
  !!a && !!b && a.type === b.type && a.size === b.size && a.hash === b.hash && (a.hash !== undefined || a.mtimeMs === b.mtimeMs);

/** Problems found by comparing the folder before and after a run; empty means the run stayed inside its rules. */
export function checkAfterRun(before: Snapshot, after: Snapshot): string[] {
  const problems: string[] = [];
  for (const [r, e] of after.entries) if (e.type === "link") problems.push(`link: ${r}`);
  const paths = new Set([...before.entries.keys(), ...after.entries.keys()]);
  for (const r of [...paths].sort()) {
    const a = before.entries.get(r);
    const b = after.entries.get(r);
    if (same(a, b) || (a?.type === "dir" && b?.type === "dir")) continue;
    if (b?.type === "link") continue; // already reported
    if (r === "work/ref" || r.startsWith("work/ref/")) problems.push(`reference file changed: ${r}`);
    else if (r === "work/.claude" || r.startsWith("work/.claude/")) problems.push(`the skills folder (.claude) changed: ${r}`);
    else if (r === "work" || r.startsWith("work/")) continue;
    else problems.push(`outside the work folder: ${r}`);
  }
  if (after.workBytes > WORK_LIMITS.maxBytes) problems.push("the work folder is over 200 MB");
  if (after.workFiles > WORK_LIMITS.maxFiles) problems.push("the work folder has more than 5000 files");
  return problems;
}

/** The default seeds of every engine run (old-kit-import): the skills, brand rules, old shorts and library index from engine-kit/. */
export function engineKitSeeds(repoRoot: string): WorkspaceSeeds {
  const kit = path.join(repoRoot, "engine-kit");
  return {
    skillsDir: path.join(kit, "skills"),
    refDirs: [
      { from: path.join(kit, "brand"), to: "brand" },
      { from: path.join(kit, "examples"), to: "examples" },
      { from: path.join(kit, "lib"), to: "lib" },
    ],
  };
}
