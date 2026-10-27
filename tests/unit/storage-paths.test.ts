import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attemptDir, normalizeRelPath, safeJoin, storageRoot, videoPath } from "@/server/storage/paths";

const VID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const RUN = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";
let base: string;
let root: string;
let outside: string;

beforeAll(() => {
  base = mkdtempSync(path.join(tmpdir(), "ytstudio-paths-"));
  root = path.join(base, "root");
  outside = path.join(base, "outside");
  mkdirSync(path.join(root, "videos", VID), { recursive: true });
  mkdirSync(outside);
  writeFileSync(path.join(outside, "secret.txt"), "top secret");
  symlinkSync(outside, path.join(root, "videos", "escape-dir"));
  symlinkSync(path.join(outside, "secret.txt"), path.join(root, "videos", VID, "escape-file.txt"));
  writeFileSync(path.join(root, "videos", VID, "ok.txt"), "fine");
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("layout", () => {
  it("videoPath_and_attemptDir_follow_the_documented_layout", () => {
    expect(videoPath(root, VID)).toBe(path.join(root, "videos", VID));
    expect(videoPath(root, VID, "final.mp4")).toBe(path.join(root, "videos", VID, "final.mp4"));
    expect(attemptDir(root, VID, RUN, 3)).toBe(path.join(root, "videos", VID, `attempt-${RUN}-3`));
  });
  it("layout_helpers_refuse_bad_ids_stage_names_and_fences", () => {
    expect(() => videoPath(root, "../x")).toThrow();
    expect(() => videoPath(root, "not-a-uuid")).toThrow();
    expect(() => videoPath(root, VID, "..", "x")).toThrow();
    expect(() => attemptDir(root, VID, "../x", 1)).toThrow();
    expect(() => attemptDir(root, VID, "a/b", 1)).toThrow();
    expect(() => attemptDir(root, VID, "", 1)).toThrow();
    expect(() => attemptDir(root, VID, "render", 1)).toThrow(); // a stage name is not a stage run id
    expect(() => attemptDir(root, VID, RUN, 0)).toThrow();
    expect(() => attemptDir(root, VID, RUN, 1.5)).toThrow();
    expect(() => attemptDir(root, VID, RUN, -1)).toThrow();
  });
  it("storageRoot_is_absolute_and_honours_STORAGE_ROOT", () => {
    const old = process.env.STORAGE_ROOT;
    try {
      process.env.STORAGE_ROOT = "relative/dir";
      expect(path.isAbsolute(storageRoot())).toBe(true);
      process.env.STORAGE_ROOT = root;
      expect(storageRoot()).toBe(root);
    } finally {
      if (old === undefined) delete process.env.STORAGE_ROOT;
      else process.env.STORAGE_ROOT = old;
    }
  });
});

describe("normalizeRelPath", () => {
  it("accepts_plain_relative_paths", () => {
    expect(normalizeRelPath("videos/a/b.mp4")).toBe("videos/a/b.mp4");
    expect(normalizeRelPath("a")).toBe("a");
  });
  it.each([
    "", "/abs", "a//b", "a/./b", "a/../b", "..", ".", "a/..", "a\\b", "a\0b", "a/b\0", "a/\u0001", "a/b/", "./a", "a/\u007f",
    "x".repeat(1100),
  ])("rejects_%j", (p) => {
    expect(normalizeRelPath(p)).toBeNull();
  });
});

describe("safeJoin", () => {
  it("traversal_nul_and_symlink_escape_are_refused", async () => {
    for (const parts of [["..", "outside", "secret.txt"], ["videos", "..", "..", "outside"], ["/etc/passwd"], ["videos\0x"], ["a\\..\\..\\b"], ["videos", "a/../../outside"], [""], [".."]]) {
      await expect(safeJoin(root, ...parts), JSON.stringify(parts)).rejects.toThrow();
    }
    // a symlinked directory pointing outside, and a symlinked file pointing outside
    await expect(safeJoin(root, "videos", "escape-dir", "secret.txt")).rejects.toThrow();
    await expect(safeJoin(root, "videos", "escape-dir")).rejects.toThrow();
    await expect(safeJoin(root, "videos", VID, "escape-file.txt")).rejects.toThrow();
    // a not-yet-existing file below a symlinked directory is refused too (writes must not escape)
    await expect(safeJoin(root, "videos", "escape-dir", "new.txt")).rejects.toThrow();
  });
  it("returns_the_lexical_path_for_files_inside_and_for_files_not_yet_created", async () => {
    expect(await safeJoin(root, "videos", VID, "ok.txt")).toBe(path.join(root, "videos", VID, "ok.txt"));
    expect(await safeJoin(root, "videos", VID, "new", "deep", "file.bin")).toBe(path.join(root, "videos", VID, "new", "deep", "file.bin"));
  });
  it("works_when_the_root_itself_is_reached_through_a_symlink", async () => {
    const link = path.join(base, "root-link");
    symlinkSync(root, link);
    expect(await safeJoin(link, "videos", VID, "ok.txt")).toBe(path.join(link, "videos", VID, "ok.txt"));
    await expect(safeJoin(link, "videos", "escape-dir", "secret.txt")).rejects.toThrow();
  });
  it("a_prefix_sibling_of_the_root_is_not_inside_it", async () => {
    mkdirSync(path.join(base, "root-evil"));
    symlinkSync(path.join(base, "root-evil"), path.join(root, "videos", "sibling"));
    await expect(safeJoin(root, "videos", "sibling", "x")).rejects.toThrow();
  });
});
