import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildEngineConfig } from "@/server/core/engine-config";
import { KnownFailure } from "@/server/core/paid-call";
import type { StageContext } from "@/server/core/stage-handler";
import type { ChildResult, ChildSpec } from "@/server/render/child";
import { checkNativeRenderReady, MIN_FREE_BYTES, REMOTION_PIN } from "@/server/providers/renderer/native-preflight";
import { createNativeRenderer, NATIVE_IMAGE, type NativeRendererDeps } from "@/server/providers/renderer/remotion-native";
import { SCALE3D_DEMO } from "@/shared/scale3d";

const GOOD = path.resolve("tests/fixtures/video/good.mp4");
const SIZE = { width: 1080, height: 1920 };
const DONE: ChildResult = { code: 0, signal: null, truncated: false, timedOut: false, aborted: false };

let root: string;
let attemptDir: string;
let logs: string[];
let calls: ChildSpec[];
let ac: AbortController;
let progress: number[];

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "rn-")));
  attemptDir = path.join(root, "videos", "v1", "attempt-r1-1");
  mkdirSync(attemptDir, { recursive: true });
  logs = [];
  calls = [];
  progress = [];
  ac = new AbortController();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const settings = (native: boolean, timeout?: number) =>
  buildEngineConfig(new Map<string, unknown>([["render.native_3d", native], ...(timeout ? ([["render.native_timeout_s", timeout]] as [string, unknown][]) : [])]));
function ctx(native = true, timeout?: number): StageContext {
  return {
    stage: { name: "render", videoId: "v1" }, claim: { stageRunId: "run-1", fence: 1 }, config: settings(native, timeout), signal: ac.signal, attemptDir,
    log: (l: string) => logs.push(l), progress: (p: number) => progress.push(p), nextStep: () => 0, paid: async () => { throw new Error("no paid calls"); },
  } as unknown as StageContext;
}

const outFileOf = (spec: ChildSpec) => spec.args[spec.args.indexOf("--scale3d") - 1]!;
const inDirOf = (spec: ChildSpec) => spec.args[spec.args.indexOf("--scale3d") - 2]!;
const READY = { ready: true, message: "Ready", chromeDir: path.resolve("tests/fixtures") };

function deps(behave?: (spec: ChildSpec) => Promise<ChildResult> | ChildResult, over: Partial<NativeRendererDeps> = {}): NativeRendererDeps {
  return {
    root,
    kitDir: path.resolve("remotion/kit"),
    homeDir: root,
    preflight: async () => READY,
    probe: async () => ({ width: 1080, height: 1920, durationS: 2, hasAudio: false, meanDb: -20, peakDb: -1, loopDiff: 1 }),
    runChild: async (spec) => {
      calls.push(spec);
      if (behave) return behave(spec);
      for (const l of ["PROGRESS 0", "PROGRESS 55", "PROGRESS 100"]) spec.onLine?.(l);
      copyFileSync(GOOD, outFileOf(spec));
      return DONE;
    },
    ...over,
  };
}

const args = (over: object = {}) => ({ sceneFile: "unused", scale3d: SCALE3D_DEMO, audioFile: path.join(root, "narration.wav"), captions: [{ word: "hi", startS: 0, endS: 0.5 }], outFile: "render.mp4", size: SIZE, ...over });

describe("native renderer", () => {
  it("runs the sandboxed command with no env, the native time limit and the caller's signal, and returns the checked mp4", async () => {
    let props: Record<string, unknown> | undefined;
    const r = await createNativeRenderer(deps((spec) => {
      props = JSON.parse(readFileSync(path.join(inDirOf(spec), "props.json"), "utf8"));
      expect(readFileSync(path.join(inDirOf(spec), "props.json"), "utf8").length).toBeGreaterThan(10);
      copyFileSync(GOOD, outFileOf(spec));
      return DONE;
    })).render(ctx(true, 3000), args());
    expect(r).toEqual({ outPath: path.join(attemptDir, "render.mp4"), image: NATIVE_IMAGE });
    expect(existsSync(r.outPath)).toBe(true);
    const s = calls[0]!;
    expect(s.command).toBe("/usr/bin/nice");
    expect(s.args.slice(0, 4)).toEqual(["-n", "10", "/usr/bin/sandbox-exec", "-p"]);
    expect(s.args).toEqual(expect.arrayContaining(["/usr/bin/env", "-i", "--scale3d", "--native"]));
    expect(s.envAllow).toEqual([]);
    expect(s.timeoutMs).toBe(3_000_000);
    expect(s.signal).toBe(ac.signal);
    // cwd is the allowed private temp folder: under the read-denied storage root the attempt folder itself makes process.cwd() fail (EPERM)
    expect(s.cwd).toBe(path.join(realpathSync(attemptDir), "native-tmp"));
    expect(s.cwdRoot).toBe(realpathSync(attemptDir));
    expect(props).toMatchObject({ scene: expect.any(Object), captions: [{ word: "hi", startS: 0, endS: 0.5 }] });
    // the profile names this job's folders and denies the network
    const profile = s.args[4]!;
    expect(profile).toContain("(deny network*)");
    expect(profile).toContain(`(subpath "${realpathSync(attemptDir)}/native-out")`);
    expect(profile).toContain(`(deny file-read-data (subpath "${realpathSync(root)}")`);
  });

  it("the default native time limit is 1800 s", async () => {
    await createNativeRenderer(deps()).render(ctx(), args());
    expect(calls[0]!.timeoutMs).toBe(1_800_000);
  });

  it("PROGRESS lines go to ctx.progress; other lines are logged redacted", async () => {
    await createNativeRenderer(deps((spec) => {
      spec.onLine?.("PROGRESS 40");
      spec.onLine?.("Bearer abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG");
      copyFileSync(GOOD, outFileOf(spec));
      return DONE;
    })).render(ctx(), args());
    expect(progress).toEqual([40]);
    expect(logs.join("\n")).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG");
  });

  it("job folders are removed afterwards, on success and on failure", async () => {
    await createNativeRenderer(deps()).render(ctx(), args());
    for (const d of ["native-in", "native-out", "native-tmp"]) expect(existsSync(path.join(attemptDir, d)), d).toBe(false);
    await expect(createNativeRenderer(deps(() => ({ ...DONE, code: 1 }))).render(ctx(), args())).rejects.toThrow(KnownFailure);
    for (const d of ["native-in", "native-out", "native-tmp"]) expect(existsSync(path.join(attemptDir, d)), d).toBe(false);
  });

  it("refuses when the setting is off, and starts nothing", async () => {
    await expect(createNativeRenderer(deps()).render(ctx(false), args())).rejects.toThrow(/switched off in Settings/);
    expect(calls).toHaveLength(0);
  });

  it("refuses when sandbox-exec is missing (real preflight with the check failing), and starts nothing", async () => {
    const preflight = () => checkNativeRenderReady({ platform: "darwin", repoRoot: "/x", storageRoot: "/x", executable: () => false, moduleVersion: () => REMOTION_PIN, findChrome: () => "/x/c/chrome-headless-shell", freeBytes: () => MIN_FREE_BYTES });
    await expect(createNativeRenderer(deps(undefined, { preflight })).render(ctx(), args())).rejects.toThrow(/sandbox-exec\) is missing/);
    expect(calls).toHaveLength(0);
  });

  it("refuses when the preflight is not ready, whatever the message", async () => {
    const preflight = async () => ({ ready: false, message: "Not ready: x.", chromeDir: null });
    await expect(createNativeRenderer(deps(undefined, { preflight })).render(ctx(), args())).rejects.toThrow(/not available: Not ready: x/);
    // ready but no Chrome folder is also a refusal: the sandbox would have nothing to allow
    await expect(createNativeRenderer(deps(undefined, { preflight: async () => ({ ready: true, message: "Ready", chromeDir: null }) })).render(ctx(), args())).rejects.toThrow(KnownFailure);
    expect(calls).toHaveLength(0);
  });

  it("only renders 3D scale videos", async () => {
    await expect(createNativeRenderer(deps()).render(ctx(), args({ scale3d: undefined }))).rejects.toThrow(/only renders 3D/);
    expect(calls).toHaveLength(0);
  });

  it("a plain file name only for the output", async () => {
    await expect(createNativeRenderer(deps()).render(ctx(), args({ outFile: "../x.mp4" }))).rejects.toThrow(/plain file name/);
  });

  it("a render over the time limit is a plain failure naming minutes", async () => {
    await expect(createNativeRenderer(deps(() => ({ ...DONE, code: null, signal: "SIGTERM", timedOut: true }))).render(ctx(true, 120), args())).rejects.toThrow(/2 min limit/);
  });

  it("cancelling rejects with the stage's abort reason", async () => {
    const reason = new Error("cancelled by owner");
    await expect(createNativeRenderer(deps(() => { ac.abort(reason); return { ...DONE, code: null, aborted: true }; })).render(ctx(), args())).rejects.toBe(reason);
    expect(existsSync(path.join(attemptDir, "render.mp4"))).toBe(false);
  });

  it("too much output, and a failing exit with its last lines", async () => {
    await expect(createNativeRenderer(deps(() => ({ ...DONE, truncated: true }))).render(ctx(), args())).rejects.toThrow(/too much output/);
    await expect(createNativeRenderer(deps((spec) => { spec.onLine?.("boom one"); spec.onLine?.("boom two"); return { ...DONE, code: 3 }; })).render(ctx(), args())).rejects.toThrow(/exit 3.*boom one \| boom two/);
  });

  describe("output checks (same as the container)", () => {
    it("no video file", async () => {
      await expect(createNativeRenderer(deps(() => DONE)).render(ctx(), args())).rejects.toThrow(/made no video file/);
    });
    it("a symlink named out.mp4 is not followed", async () => {
      const secret = path.join(root, "secret.mp4");
      copyFileSync(GOOD, secret);
      await expect(createNativeRenderer(deps((spec) => { symlinkSync(secret, outFileOf(spec)); return DONE; })).render(ctx(), args())).rejects.toThrow(/made no video file/);
    });
    it("a file that is not a readable video", async () => {
      const d = deps((spec) => { writeFileSync(outFileOf(spec), "not a video"); return DONE; }, { probe: async () => { throw new Error("ffprobe failed"); } });
      await expect(createNativeRenderer(d).render(ctx(), args())).rejects.toThrow(/not a readable video/);
    });
    it("wrong size", async () => {
      const d = deps(undefined, { probe: async () => ({ width: 720, height: 1280, durationS: 2, hasAudio: false, meanDb: 0, peakDb: 0, loopDiff: 0 }) });
      await expect(createNativeRenderer(d).render(ctx(), args())).rejects.toThrow(/720x1280, expected 1080x1920/);
    });
    it("empty video", async () => {
      const d = deps(undefined, { probe: async () => ({ width: 1080, height: 1920, durationS: 0, hasAudio: false, meanDb: 0, peakDb: 0, loopDiff: 0 }) });
      await expect(createNativeRenderer(d).render(ctx(), args())).rejects.toThrow(/empty/);
    });
    it("too big", async () => {
      await expect(createNativeRenderer(deps(undefined, { maxVideoBytes: 10 })).render(ctx(), args())).rejects.toThrow(/too big/);
    });
    it("a duration more than 1 s from the scenes is logged as a warning, not a failure", async () => {
      const d = deps(undefined, { probe: async () => ({ width: 1080, height: 1920, durationS: 500, hasAudio: false, meanDb: 0, peakDb: 0, loopDiff: 0 }) });
      await createNativeRenderer(d).render(ctx(), args());
      expect(logs.join("\n")).toMatch(/warning: the video is 500\.0 s/);
    });
  });
});
