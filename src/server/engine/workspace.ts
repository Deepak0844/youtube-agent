import { createHash } from "node:crypto";
import { chmod, cp, lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
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

/**
 * The nearest folder at or above `dir` holding Claude Code project settings (`.claude/`, `CLAUDE.md`, `CLAUDE.local.md`), or null.
 * Claude Code loads those from every parent folder, so a run folder inside such a project (like this repo's .data/) would inherit
 * its skills and instructions (probed 2026-11-13). Engine runs must live where no parent has any.
 */
export function claudeProjectAbove(dir: string): string | null {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    for (const n of [".claude", "CLAUDE.md", "CLAUDE.local.md"]) if (existsSync(path.join(d, n))) return d;
    if (path.dirname(d) === d) return null;
  }
}

/** Where engine run folders live by default: the system temp folder (no Claude project above it), never inside the repo. */
export function defaultEngineRoot(): string {
  return path.join(realpathSync(tmpdir()), "ytstudio-engine");
}

const INPUT_NAME = /^[a-z0-9][a-z0-9_.-]{0,60}\.(json|md|txt)$/;
const MAX_INPUT_BYTES = 512 * 1024;

/** Creates (or re-creates, empty) the run folder of one video and copies the seeds in, read-only; `inputs` are this run's own files (work/input/<name>, read-only). */
export async function prepareWorkspace(root: string, videoId: string, seeds: WorkspaceSeeds = {}, inputs: Record<string, string> = {}): Promise<Workspace> {
  const entries = Object.entries(inputs);
  for (const [name] of entries) if (!INPUT_NAME.test(name)) throw new Error(`engine workspace: bad input file name ${JSON.stringify(name.slice(0, 40))}`);
  if (entries.reduce((n, [, text]) => n + Buffer.byteLength(text), 0) > MAX_INPUT_BYTES) throw new Error("engine workspace: the input files are over 512 KB");
  if (!UUID.test(videoId)) throw new Error("engine workspace: bad video id");
  const above = claudeProjectAbove(root);
  if (above) throw new Error(`engine workspace: ${above} holds Claude Code project settings; engine runs must not live inside it`);
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
  if (entries.length > 0) {
    const to = path.join(workDir, "input");
    await mkdir(to);
    for (const [name, text] of entries) await writeFile(path.join(to, name), text, { flag: "wx" });
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
    else if (r === "work/input" || r.startsWith("work/input/")) problems.push(`input file changed: ${r}`);
    else if (r === "work" || r.startsWith("work/")) continue;
    else problems.push(`outside the work folder: ${r}`);
  }
  if (after.workBytes > WORK_LIMITS.maxBytes) problems.push("the work folder is over 200 MB");
  if (after.workFiles > WORK_LIMITS.maxFiles) problems.push("the work folder has more than 5000 files");
  return problems;
}

/** The default seeds of every engine run: the skills, brand rules, old shorts and library index from engine-kit/ (old-kit-import), and OpenMontage's pipelines, guides, schemas and styles (engine-kit/openmontage/ref, AGPL-3.0) as ref/openmontage. */
export function engineKitSeeds(repoRoot: string): WorkspaceSeeds {
  const kit = path.join(repoRoot, "engine-kit");
  return {
    skillsDir: path.join(kit, "skills"),
    refDirs: [
      { from: path.join(kit, "brand"), to: "brand" },
      { from: path.join(kit, "examples"), to: "examples" },
      { from: path.join(kit, "lib"), to: "lib" },
      { from: path.join(kit, "openmontage", "ref"), to: "openmontage" },
    ],
  };
}
