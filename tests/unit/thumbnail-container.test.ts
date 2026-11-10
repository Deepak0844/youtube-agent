import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildEngineConfig } from "@/server/core/engine-config";
import { KnownFailure } from "@/server/core/paid-call";
import type { StageContext } from "@/server/core/stage-handler";
import { createThumbnailRenderer, pngProblem } from "@/server/providers/renderer/thumbnail-container";
import type { ChildSpec } from "@/server/render/child";

const IMAGE_ID = `sha256:${"a".repeat(64)}`;
let root: string;
let attemptDir: string;
let calls: ChildSpec[];

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "thumb-")));
  attemptDir = path.join(root, "videos", "v1", "attempt-r1-1");
  mkdirSync(attemptDir, { recursive: true });
  mkdirSync(path.join(root, "assets", "j1"), { recursive: true });
  copyFileSync("tests/fixtures/assets/plain.png", path.join(root, "assets", "j1", "main.png"));
  calls = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const ctx = () => ({ stage: { name: "thumbnail", videoId: "v1" }, claim: { stageRunId: "run-1", fence: 1 }, config: buildEngineConfig(new Map()), signal: new AbortController().signal, attemptDir, log: () => undefined }) as unknown as StageContext;
const mountOf = (args: string[], dst: string) => args[args.findIndex((a, i) => args[i - 1] === "-v" && a.split(":")[1] === dst)]!.split(":")[0]!;

/** A tiny png header: signature plus an IHDR chunk with the given size (enough for the host's check). */
const pngHead = (w: number, h: number) => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(b, 0);
  b.write("IHDR", 12);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};

const renderer = (behave?: (outDir: string, inDir: string) => void | { code: number }) =>
  createThumbnailRenderer({
    root, kitDir: path.resolve("remotion/kit"), hostLimits: async () => ({ cpus: 2, memoryMb: 3000 }), image: async () => ({ ref: IMAGE_ID, pinned: true }), workerId: "w-1", sweepDelayMs: 1,
    runChild: async (spec) => {
      calls.push(spec);
      if (spec.args[0] !== "run") return { code: 0, signal: null, truncated: false, timedOut: false, aborted: false };
      const outDir = mountOf(spec.args, "/out");
      const inDir = mountOf(spec.args, "/in");
      const r = behave ? behave(outDir, inDir) : (writeFileSync(path.join(outDir, "out.png"), pngHead(1280, 720)), undefined);
      return { code: r?.code ?? 0, signal: null, truncated: false, timedOut: false, aborted: false };
    },
  });
const runs = () => calls.filter((c) => c.args[0] === "run");

describe("pngProblem", () => {
  it("accepts a 1280x720 png and refuses other sizes and non-pngs", () => {
    expect(pngProblem(pngHead(1280, 720))).toBeNull();
    expect(pngProblem(pngHead(1920, 1080))).toMatch(/1920x1080, expected 1280x720/);
    expect(pngProblem(Buffer.from("GIF89a" + "x".repeat(30)))).toMatch(/not a png/);
    expect(pngProblem(Buffer.alloc(5))).toMatch(/not a png/);
  });
});

describe("thumbnail renderer", () => {
  it("runs the --thumbnail mode in the sandbox with the title staged, and returns the card inside the attempt folder", async () => {
    let props: unknown;
    const r = await renderer((outDir, inDir) => {
      props = JSON.parse(readFileSync(path.join(inDir, "props.json"), "utf8"));
      writeFileSync(path.join(outDir, "out.png"), pngHead(1280, 720));
    }).draw(ctx(), { title: "  Why the sea is salty ", seed: "v1", outFile: "thumbnail.png" });
    expect(r).toEqual({ outPath: path.join(attemptDir, "thumbnail.png"), image: IMAGE_ID });
    expect(runs()[0]!.args.slice(-4)).toEqual(["/opt/render/kit/render-entry.mjs", "/in", "/out/out.png", "--thumbnail"]);
    expect(runs()[0]!.args).toContain("--network");
    expect(props).toEqual({ title: "Why the sea is salty", seed: "v1" });
    expect(readdirSync(attemptDir)).toEqual(["thumbnail.png"]); // the staging folders are gone
  });

  it("stages one picture from the storage root as a plain file and names it in props.json", async () => {
    let seen: { files: string[]; props: unknown } | undefined;
    await renderer((outDir, inDir) => {
      seen = { files: readdirSync(inDir).sort(), props: JSON.parse(readFileSync(path.join(inDir, "props.json"), "utf8")) };
      writeFileSync(path.join(outDir, "out.png"), pngHead(1280, 720));
    }).draw(ctx(), { title: "T", seed: "v1", pictureRef: "assets/j1/main.png", outFile: "thumbnail.png" });
    expect(seen).toEqual({ files: ["picture.png", "props.json"], props: { title: "T", seed: "v1", src: "picture.png" } });
  });

  it("refuses a bad title, file name, picture type or picture path before any container starts", async () => {
    const t = renderer();
    await expect(t.draw(ctx(), { title: "  ", seed: "v1", outFile: "t.png" })).rejects.toThrow(/title/);
    await expect(t.draw(ctx(), { title: "x".repeat(301), seed: "v1", outFile: "t.png" })).rejects.toThrow(/title/);
    for (const bad of ["", "../t.png", ".t.png", "t.mp4", "a/b.png"]) await expect(t.draw(ctx(), { title: "T", seed: "v1", outFile: bad }), bad).rejects.toThrow(/plain \.png/);
    await expect(t.draw(ctx(), { title: "T", seed: "v1", pictureRef: "assets/j1/clip.mp4", outFile: "t.png" })).rejects.toThrow(/file type/);
    await expect(t.draw(ctx(), { title: "T", seed: "v1", pictureRef: "../../etc/passwd.png", outFile: "t.png" })).rejects.toThrow(/could not be read/);
    expect(runs()).toHaveLength(0);
  });

  it("fails plainly when the container fails, makes no file, or makes the wrong picture, and keeps nothing", async () => {
    await expect(renderer(() => ({ code: 1 })).draw(ctx(), { title: "T", seed: "v1", outFile: "t.png" })).rejects.toThrow(/thumbnail failed \(exit 1\)/);
    await expect(renderer(() => undefined).draw(ctx(), { title: "T", seed: "v1", outFile: "t.png" })).rejects.toThrow(/made no thumbnail/);
    const e = await renderer((outDir) => writeFileSync(path.join(outDir, "out.png"), pngHead(640, 360))).draw(ctx(), { title: "T", seed: "v1", outFile: "t.png" }).then(() => null, (x: unknown) => x as Error);
    expect(e).toBeInstanceOf(KnownFailure);
    expect(e?.message).toMatch(/640x360/);
    expect(existsSync(path.join(attemptDir, "t.png"))).toBe(false);
    expect(readdirSync(attemptDir)).toEqual([]);
  });
});
