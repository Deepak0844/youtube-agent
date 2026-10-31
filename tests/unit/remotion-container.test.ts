import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildEngineConfig } from "@/server/core/engine-config";
import { KnownFailure } from "@/server/core/paid-call";
import { StageAbort, type StageContext } from "@/server/core/stage-handler";
import type { ChildResult, ChildSpec } from "@/server/render/child";
import { createContainerRenderer, parseProgress, type ContainerRendererDeps } from "@/server/providers/renderer/remotion-container";

const GOOD = path.resolve("tests/fixtures/video/good.mp4");
const SIZE = { width: 1080, height: 1920 };
const doc = (scenes: unknown[]) => ({ version: 1, scenes }) as never;
const terminal = { id: "s1", beat: "b1", kind: "terminal", startMs: 0, durationMs: 1000, lines: [{ text: "ls" }] };
const story = (image: string) => ({ id: "s2", beat: "b2", kind: "story_kenburns", startMs: 1000, durationMs: 1000, image });

let root: string;
let attemptDir: string;
let logs: string[];
let calls: ChildSpec[];
let ac: AbortController;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "rc-")));
  attemptDir = path.join(root, "videos", "v1", "attempt-r1-1");
  mkdirSync(attemptDir, { recursive: true });
  mkdirSync(path.join(root, "assets", "j1"), { recursive: true });
  copyFileSync("tests/fixtures/assets/plain.png", path.join(root, "assets", "j1", "main.png"));
  writeFileSync(path.join(root, "videos", "v1", "narration.wav"), readFileSync("tests/fixtures/assets/tone.wav"));
  logs = [];
  calls = [];
  ac = new AbortController();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function ctx(): StageContext {
  return {
    stage: { name: "render", videoId: "v1" }, claim: { stageRunId: "run-1", fence: 1 }, config: buildEngineConfig(new Map()), signal: ac.signal, attemptDir,
    log: (l: string) => logs.push(l), nextStep: () => 0, paid: async () => { throw new Error("no paid calls"); },
  } as unknown as StageContext;
}

const mountOf = (args: string[], dst: string) => args[args.findIndex((a, i) => args[i - 1] === "-v" && a.split(":")[1] === dst)];

/** Fake docker: `run` writes out.mp4 into the mounted out dir (or does `behave`), `rm -f` succeeds. */
function deps(behave?: (spec: ChildSpec, outDir: string) => Promise<ChildResult> | ChildResult, over: Partial<ContainerRendererDeps> = {}): ContainerRendererDeps {
  return {
    root,
    kitDir: path.resolve("remotion/kit"),
    hostLimits: async () => ({ cpus: 2, memoryMb: 3000 }),
    assetFile: async (id) => (id === "img1" ? "assets/j1/main.png" : null),
    probe: async () => ({ width: 1080, height: 1920, durationS: 2, hasAudio: true, meanDb: -20, peakDb: -1, loopDiff: 1 }),
    runChild: async (spec) => {
      calls.push(spec);
      if (spec.args[0] !== "run") return { code: 0, signal: null, truncated: false, timedOut: false, aborted: false };
      const outDir = mountOf(spec.args, "/out")!.split(":")[0]!;
      if (behave) return behave(spec, outDir);
      for (const l of ["PROGRESS 0", "PROGRESS 55", "PROGRESS 100"]) spec.onLine?.(l);
      copyFileSync(GOOD, path.join(outDir, "out.mp4"));
      return { code: 0, signal: null, truncated: false, timedOut: false, aborted: false };
    },
    ...over,
  };
}

const args = (d = doc([terminal, story("img1")])) => ({ sceneFile: "unused", doc: d, audioFile: path.join(root, "videos", "v1", "narration.wav"), captions: [{ word: "hi", startS: 0, endS: 0.5, source: "recognised", flags: [] }], outFile: "render.mp4", size: SIZE });
const run = () => calls.find((c) => c.args[0] === "run")!;
const removed = () => calls.filter((c) => c.args[0] === "rm").map((c) => c.args);

describe("container renderer", () => {
  it("runs docker with every sandbox flag, three exact mounts, no env, and removes the container", async () => {
    const r = await createContainerRenderer(deps()).render(ctx(), args());
    expect(r.outPath).toBe(path.join(attemptDir, "render.mp4"));
    const s = run();
    expect(s.command).toBe("docker");
    expect(s.envAllow).toEqual(["PATH"]);
    expect(s.timeoutMs).toBe(600_000);
    const a = s.args;
    const name = a[a.indexOf("--name") + 1]!;
    expect(name).toMatch(/^ytstudio-render-run-1-[0-9a-f]{8}$/);
    for (const flag of ["--rm", "--read-only", "--pull=never"]) expect(a).toContain(flag);
    const pair = (k: string) => a[a.indexOf(k) + 1];
    expect(pair("--network")).toBe("none");
    expect(pair("--cap-drop")).toBe("ALL");
    expect(pair("--security-opt")).toBe("no-new-privileges");
    expect(pair("--user")).toBe("10001:10001");
    expect(pair("--pids-limit")).toBe("512");
    expect(pair("--cpus")).toBe("2"); // clamped to the daemon
    expect(pair("--memory")).toBe("2700m"); // 90% of the daemon's 3000
    expect(pair("--memory-swap")).toBe("2700m");
    const mounts = a.filter((_, i) => a[i - 1] === "-v");
    expect(mounts).toEqual([`${attemptDir}/render-in:/in:ro`, `${attemptDir}/render-out:/out:rw`, `${path.resolve("remotion/kit")}:/opt/render/kit:ro`]);
    for (const bad of ["-e", "--env", "--env-file", "--privileged", "--cap-add", "--mount", "--volumes-from", "-p", "--network=host"]) expect(a).not.toContain(bad);
    expect(a.slice(-4)).toEqual(["ytstudio-render:dev", "/opt/render/kit/render-entry.mjs", "/in", "/out/out.mp4"]);
    expect(removed()).toEqual([["rm", "-f", name]]);
    // second render gets a different container name
    await createContainerRenderer(deps()).render(ctx(), args());
    const names = calls.filter((c) => c.args[0] === "run").map((c) => c.args[c.args.indexOf("--name") + 1]);
    expect(new Set(names).size).toBe(2);
  });

  it("stages only referenced assets, narration and props; scratch folders are removed afterwards", async () => {
    let seen: { files: string[]; props: Record<string, unknown> } | undefined;
    const asked: string[] = [];
    await createContainerRenderer(deps((spec, outDir) => {
      const inDir = mountOf(spec.args, "/in")!.split(":")[0]!;
      seen = { files: ["props.json", "narration.wav", "assets/img1.png"].filter((f) => existsSync(path.join(inDir, f))), props: JSON.parse(readFileSync(path.join(inDir, "props.json"), "utf8")) };
      copyFileSync(GOOD, path.join(outDir, "out.mp4"));
      return { code: 0, signal: null, truncated: false, timedOut: false, aborted: false };
    }, { assetFile: async (id) => (asked.push(id), id === "img1" ? "assets/j1/main.png" : null) })).render(ctx(), args());
    expect(asked).toEqual(["img1"]);
    expect(seen!.files).toEqual(["props.json", "narration.wav", "assets/img1.png"]);
    expect(seen!.props).toMatchObject({ audioSrc: "narration.wav", assets: { img1: "assets/img1.png" }, captions: [{ word: "hi", startS: 0, endS: 0.5, estimated: false }] });
    expect(existsSync(path.join(attemptDir, "render-in"))).toBe(false);
    expect(existsSync(path.join(attemptDir, "render-out"))).toBe(false);
  });

  it("surfaces progress as stage log lines", async () => {
    await createContainerRenderer(deps()).render(ctx(), args());
    expect(logs.filter((l) => l.startsWith("render: "))).toEqual(["render: 0%", "render: 55%", "render: 100%"]);
    expect(parseProgress("PROGRESS 42")).toBe(42);
    for (const l of ["PROGRESS 101", "progress 4", "PROGRESS 4 x", "x PROGRESS 4"]) expect(parseProgress(l)).toBeNull();
  });

  it("timeout: known failure and the container is force-removed", async () => {
    const p = createContainerRenderer(deps(() => ({ code: null, signal: "SIGKILL", truncated: false, timedOut: true, aborted: false }))).render(ctx(), args());
    await expect(p).rejects.toThrow(KnownFailure);
    await expect(p).rejects.toThrow(/10 min limit/);
    expect(removed()).toHaveLength(1);
  });

  it("abort: rejects with the stage's reason and the container is force-removed", async () => {
    const p = createContainerRenderer(deps(() => {
      ac.abort(new StageAbort("cancel"));
      return { code: null, signal: "SIGTERM", truncated: false, timedOut: false, aborted: true };
    })).render(ctx(), args());
    await expect(p).rejects.toBeInstanceOf(StageAbort);
    expect(removed()).toHaveLength(1);
    // the rm call has its own signal, never the aborted stage signal
    expect(calls.find((c) => c.args[0] === "rm")!.signal.aborted).toBe(false);
  });

  it("a failing render reports a redacted tail; over-long output fails", async () => {
    const secret = "sk-ant-api03-" + "a".repeat(40);
    const p = createContainerRenderer(deps((spec) => {
      spec.onLine?.(`Error: boom key=${secret}`);
      return { code: 1, signal: null, truncated: false, timedOut: false, aborted: false };
    })).render(ctx(), args());
    await expect(p).rejects.toThrow(KnownFailure);
    const msg = await p.catch((e: Error) => e.message);
    expect(msg).toContain("boom");
    expect(msg).not.toContain(secret);
    expect(removed()).toHaveLength(1);
    await expect(createContainerRenderer(deps(() => ({ code: null, signal: "SIGTERM", truncated: true, timedOut: false, aborted: false }))).render(ctx(), args())).rejects.toThrow(/too much output/);
  });

  it("bad output is a known failure: missing, a symlink, wrong size, or no audio", async () => {
    const ok = { code: 0, signal: null, truncated: false, timedOut: false, aborted: false } as const;
    await expect(createContainerRenderer(deps(() => ok)).render(ctx(), args())).rejects.toThrow(/no video/);
    await expect(createContainerRenderer(deps((_, out) => (symlinkSync(GOOD, path.join(out, "out.mp4")), ok))).render(ctx(), args())).rejects.toThrow(/no video/);
    const probe = (p: object) => ({ probe: async () => ({ width: 1080, height: 1920, durationS: 2, hasAudio: true, meanDb: null, peakDb: null, loopDiff: null, ...p }) });
    await expect(createContainerRenderer(deps(undefined, probe({ width: 720 }))).render(ctx(), args())).rejects.toThrow(/720x1920/);
    await expect(createContainerRenderer(deps(undefined, probe({ hasAudio: false }))).render(ctx(), args())).rejects.toThrow(/no sound/);
    await expect(createContainerRenderer(deps(undefined, { probe: async () => { throw new Error("unreadable"); } })).render(ctx(), args())).rejects.toThrow(KnownFailure);
  });

  it("asset staging refuses unknown ids, escapes, symlinks and other file types before docker runs", async () => {
    const tryRef = (ref: string | null, id = "img1") => createContainerRenderer(deps(undefined, { assetFile: async () => ref })).render(ctx(), args(doc([terminal, story(id)])));
    await expect(tryRef(null)).rejects.toThrow(/img1/);
    await expect(tryRef("../../etc/passwd.png")).rejects.toThrow(KnownFailure);
    await expect(tryRef("/etc/hosts.png")).rejects.toThrow(KnownFailure);
    symlinkSync(path.join(root, "assets", "j1", "main.png"), path.join(root, "assets", "j1", "link.png"));
    await expect(tryRef("assets/j1/link.png")).rejects.toThrow(KnownFailure);
    writeFileSync(path.join(root, "assets", "j1", "x.svg"), "<svg/>");
    await expect(tryRef("assets/j1/x.svg")).rejects.toThrow(/file type/);
    // an id the scene schema would refuse never reaches the lookup (doc not re-validated here on purpose)
    await expect(tryRef("assets/j1/main.png", "../x")).rejects.toThrow(KnownFailure);
    expect(calls.filter((c) => c.args[0] === "run")).toHaveLength(0);
  });

  it("refuses without a validated doc or with an unusable out name", async () => {
    await expect(createContainerRenderer(deps()).render(ctx(), { ...args(), doc: undefined })).rejects.toThrow(KnownFailure);
    await expect(createContainerRenderer(deps()).render(ctx(), { ...args(), outFile: "../x.mp4" })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});
