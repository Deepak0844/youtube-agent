import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authorized, readBody, resolveJobDirs } from "../../infra/render-runner/checks";

// The service's front door: who may call, how much it reads, and which folders a job may name.
const TOKEN = "t".repeat(32);

describe("authorized", () => {
  it("accepts only the exact bearer token", () => {
    expect(authorized(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
  });
  it.each([[undefined], [""], ["Bearer "], ["Bearer"], [`bearer ${TOKEN}`], [`Basic ${TOKEN}`], [TOKEN], [`Bearer ${TOKEN}x`], [`Bearer ${TOKEN.slice(1)}`], [`Bearer  ${TOKEN}`], [`Bearer ${"u".repeat(32)}`]])("refuses %j", (h) => {
    expect(authorized(h, TOKEN)).toBe(false);
  });
  it("refuses everything when the configured token is empty", () => {
    expect(authorized("Bearer ", "")).toBe(false);
    expect(authorized("Bearer x", "")).toBe(false);
  });
});

describe("readBody", () => {
  const body = (...parts: string[]) => Readable.from(parts.map((p) => Buffer.from(p)));
  it("reads a small body", async () => expect((await readBody(body('{"a":', "1}"))).toString()).toBe('{"a":1}'));
  it("accepts exactly the limit and refuses one byte more, without reading the rest", async () => {
    expect((await readBody(body("a".repeat(8192)))).length).toBe(8192);
    await expect(readBody(body("a".repeat(8193)))).rejects.toThrow("body too large");
    let pulled = 0;
    const endless = (async function* () { for (;;) { pulled++; yield Buffer.alloc(4096); } })();
    await expect(readBody(endless)).rejects.toThrow("body too large");
    expect(pulled).toBeLessThan(5);
  });
});

describe("resolveJobDirs", () => {
  let tmp: string;
  let root: string;
  const HOST = "/srv/studio/data";
  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "runner-")));
    root = path.join(tmp, "data");
    mkdirSync(path.join(root, "videos/v1/attempt-1/render-in"), { recursive: true });
    mkdirSync(path.join(root, "videos/v1/attempt-1/render-out"), { recursive: true });
    mkdirSync(path.join(tmp, "data2/videos"), { recursive: true });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));
  const job = (inDir: string, outDir = "videos/v1/attempt-1/render-out") => ({ inDir, outDir });
  const refused = (j: { inDir: string; outDir: string }) => expect(resolveJobDirs(j, root, HOST)).rejects.toThrow("render folder not allowed");

  it("accepts two real folders and returns the host paths under the host root", async () => {
    expect(await resolveJobDirs(job("videos/v1/attempt-1/render-in"), root, HOST)).toEqual({
      inDir: path.join(root, "videos/v1/attempt-1/render-in"), outDir: path.join(root, "videos/v1/attempt-1/render-out"),
      hostIn: `${HOST}/videos/v1/attempt-1/render-in`, hostOut: `${HOST}/videos/v1/attempt-1/render-out`,
    });
  });
  it.each([["../x"], ["../../etc"], ["/etc"], ["a/../../b"], ["videos/../../data2"], ["videos/v1/attempt-1/render-in/../../../../../data2/videos"]])("refuses the traversal %j", async (p) => {
    await refused(job(p));
    await refused(job("videos/v1/attempt-1/render-in", p));
  });
  it("refuses a NUL, colon, comma or line break in a folder", async () => {
    for (const p of ["a\0b", "a:/etc", "a,ro", "a\nb"]) await refused(job(p));
  });
  it("refuses a missing folder and a file", async () => {
    await refused(job("videos/v1/attempt-1/nope"));
    writeFileSync(path.join(root, "videos/v1/attempt-1/file"), "x");
    await refused(job("videos/v1/attempt-1/file"));
  });
  it("refuses a folder that is a symlink, to outside or inside the root", async () => {
    symlinkSync(path.join(tmp, "data2/videos"), path.join(root, "videos/v1/attempt-1/out-link"));
    await refused(job("videos/v1/attempt-1/out-link"));
    symlinkSync(path.join(root, "videos/v1/attempt-1/render-in"), path.join(root, "videos/v1/attempt-1/in-link"));
    await refused(job("videos/v1/attempt-1/in-link"));
  });
  it("refuses a folder reached through a symlinked parent", async () => {
    symlinkSync(path.join(tmp, "data2"), path.join(root, "linked"));
    await refused(job("linked/videos"));
  });
  it("refuses the sibling that shares the root's name as a prefix", async () => {
    await refused(job("../data2/videos"));
  });
  it("refuses the storage root itself and an empty path", async () => {
    await refused(job("."));
    await refused(job(""));
  });
  it("refuses when the host root is not absolute or could add mount options", async () => {
    for (const bad of ["relative", "/srv/a:/etc", "/srv/a,ro", "/srv/a\nb", ""]) await expect(resolveJobDirs(job("videos/v1/attempt-1/render-in"), root, bad), bad).rejects.toThrow("render folder not allowed");
  });
});
