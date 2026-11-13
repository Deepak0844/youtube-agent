import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkAfterRun, prepareWorkspace, WORK_LIMITS } from "@/server/engine/workspace";

// The locked per-video folder of an engine run (ADR 0015) and the after-run check: the last wall when Claude Code's own
// permission rules let something through.

let root: string;
let src: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "engine-ws-"));
  src = await mkdtemp(path.join(tmpdir(), "engine-seed-"));
  await mkdir(path.join(src, "skills", "make-short"), { recursive: true });
  await writeFile(path.join(src, "skills", "make-short", "SKILL.md"), "# make a short");
  await mkdir(path.join(src, "brand"), { recursive: true });
  await writeFile(path.join(src, "brand", "brand.md"), "colours");
});
afterEach(async () => {
  await chmod(root, 0o755).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
  await rm(src, { recursive: true, force: true });
});

const VID = "0190f3a2-7c1e-7a55-9d3b-2f6c8a1b4e91";
const seeds = () => ({ skillsDir: path.join(src, "skills"), refDirs: [{ from: path.join(src, "brand"), to: "brand" }] });

describe("prepareWorkspace", () => {
  it("lays out the run folder with copied, read-only seeds", async () => {
    const ws = await prepareWorkspace(root, VID, seeds());
    expect(ws.dir).toBe(path.join(root, "videos", VID, "engine"));
    expect(ws.workDir).toBe(path.join(ws.dir, "work"));
    expect(await readFile(path.join(ws.dir, ".claude", "skills", "make-short", "SKILL.md"), "utf8")).toBe("# make a short");
    const ref = path.join(ws.workDir, "ref", "brand", "brand.md");
    expect(await readFile(ref, "utf8")).toBe("colours");
    expect((await stat(ref)).mode & 0o222).toBe(0); // no write bits
    expect((await stat(ws.home)).isDirectory()).toBe(true);
  });

  it("refuses a video id that is not a uuid", async () => {
    await expect(prepareWorkspace(root, "../../etc", seeds())).rejects.toThrow(/video id/);
  });

  it("starts clean each time (an old run's files are gone)", async () => {
    const ws = await prepareWorkspace(root, VID, seeds());
    await writeFile(path.join(ws.workDir, "old.tsx"), "x");
    const again = await prepareWorkspace(root, VID, seeds());
    await expect(stat(path.join(again.workDir, "old.tsx"))).rejects.toThrow();
  });
});

describe("checkAfterRun", () => {
  it("a normal run that writes in work passes", async () => {
    const ws = await prepareWorkspace(root, VID, seeds());
    const before = await ws.snapshot();
    await mkdir(path.join(ws.workDir, "scene"), { recursive: true });
    await writeFile(path.join(ws.workDir, "scene", "video.tsx"), "export const V = 1;");
    expect(checkAfterRun(before, await ws.snapshot())).toEqual([]);
  });

  it("change_outside_work_is_reported", async () => {
    const ws = await prepareWorkspace(root, VID, seeds());
    const before = await ws.snapshot();
    await writeFile(path.join(ws.dir, "escaped.txt"), "x");
    await writeFile(path.join(ws.home, ".zshrc"), "x");
    expect(checkAfterRun(before, await ws.snapshot()).join(" ")).toMatch(/outside the work folder: escaped\.txt/);
  });

  it("write_into_dot_claude_is_reported", async () => {
    const ws = await prepareWorkspace(root, VID, seeds());
    const before = await ws.snapshot();
    await chmod(path.join(ws.dir, ".claude", "skills", "make-short", "SKILL.md"), 0o644);
    await writeFile(path.join(ws.dir, ".claude", "skills", "make-short", "SKILL.md"), "evil");
    expect(checkAfterRun(before, await ws.snapshot()).join(" ")).toMatch(/\.claude/);
  });

  it("a changed reference file is reported", async () => {
    const ws = await prepareWorkspace(root, VID, seeds());
    const before = await ws.snapshot();
    const ref = path.join(ws.workDir, "ref", "brand", "brand.md");
    await chmod(ref, 0o644);
    await writeFile(ref, "new colours");
    expect(checkAfterRun(before, await ws.snapshot()).join(" ")).toMatch(/reference file changed: work\/ref\/brand\/brand\.md/);
  });

  it("symlink_in_work_is_reported", async () => {
    const ws = await prepareWorkspace(root, VID, seeds());
    const before = await ws.snapshot();
    await symlink("/etc/hosts", path.join(ws.workDir, "hosts"));
    expect(checkAfterRun(before, await ws.snapshot()).join(" ")).toMatch(/link: work\/hosts/);
  });

  it("over_the_size_or_file_count_limit_is_reported", async () => {
    const ws = await prepareWorkspace(root, VID, seeds());
    const before = await ws.snapshot();
    await writeFile(path.join(ws.workDir, "a.bin"), "x");
    const after = await ws.snapshot();
    const big = { ...after, workBytes: WORK_LIMITS.maxBytes + 1 };
    const many = { ...after, workFiles: WORK_LIMITS.maxFiles + 1 };
    expect(checkAfterRun(before, big).join(" ")).toMatch(/200 MB/);
    expect(checkAfterRun(before, many).join(" ")).toMatch(/5000 files/);
    expect(WORK_LIMITS).toEqual({ maxBytes: 200 * 1024 * 1024, maxFiles: 5000 });
  });
});
