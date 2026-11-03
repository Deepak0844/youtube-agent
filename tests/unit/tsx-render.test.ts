import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildEngineConfig } from "@/server/core/engine-config";
import type { StageContext } from "@/server/core/stage-handler";
import type { ChildResult, ChildSpec } from "@/server/render/child";
import { renderTsx, scrub, type TsxRendererDeps } from "@/server/providers/renderer/tsx-render";

const GOOD_MP4 = path.resolve("tests/fixtures/video/good.mp4");
const W = 1080;
const H = 1920;
const SCENE = `import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame } from "remotion";

export default function Scene({ title }: { title: string }) {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 30], [0, 1], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ backgroundColor: "#123", opacity }}>
      <Img src={staticFile("pics/a.png")} />
      <p>{title}</p>
    </AbsoluteFill>
  );
}
export const meta = { durationInFrames: 90, fps: 30, width: 1080, height: 1920 };
`;
const OK: ChildResult = { code: 0, signal: null, truncated: false, timedOut: false, aborted: false };

let root: string;
let attemptDir: string;
let picture: string;
let calls: ChildSpec[];
let logs: string[];
let ac: AbortController;
let seen: { video?: string; props?: string; meta?: string; asset?: boolean; entries: string[][] };

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "tsxr-")));
  attemptDir = path.join(root, "attempt");
  mkdirSync(attemptDir);
  picture = path.join(root, "a.png");
  copyFileSync("tests/fixtures/assets/plain.png", picture);
  calls = [];
  logs = [];
  ac = new AbortController();
  seen = { entries: [] };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function ctx(): StageContext {
  return {
    stage: { name: "render", videoId: "v1" }, claim: { stageRunId: "run-1", fence: 1 }, config: buildEngineConfig(new Map()), signal: ac.signal, attemptDir,
    log: (l: string) => logs.push(l), nextStep: () => 0, paid: async () => { throw new Error("no paid calls"); },
  } as unknown as StageContext;
}

const mountOf = (args: string[], dst: string) => args[args.findIndex((a, i) => args[i - 1] === "-v" && a.split(":")[1] === dst)]!.split(":")[0]!;
/** A raw RGB frame: a dark background with a bright block whose position moves with the frame number. */
const frameBytes = (f: number) => {
  const b = Buffer.alloc(W * H * 3, 20);
  for (let y = 100; y < 400; y++) for (let x = 100 + f * 5; x < 400 + f * 5; x++) b.fill(230, (y * W + x) * 3, (y * W + x) * 3 + 3);
  return b;
};

type Behave = { stills?: (outDir: string) => ChildResult; video?: (outDir: string) => ChildResult; decode?: (spec: ChildSpec) => ChildResult };
function deps(behave: Behave = {}, over: Partial<TsxRendererDeps> = {}): TsxRendererDeps {
  return {
    kitDir: path.resolve("remotion/kit"),
    hostLimits: async () => ({ cpus: 4, memoryMb: 8000 }),
    image: async () => ({ ref: "sha256:" + "b".repeat(64), pinned: true }),
    workerId: "w-1",
    sweepDelayMs: 1,
    typeCheck: async () => ({ ok: true, problems: [] }),
    probe: async () => ({ width: W, height: H, durationS: 3, hasAudio: false, meanDb: null, peakDb: null, loopDiff: 1 }),
    runChild: async (spec) => {
      calls.push(spec);
      if (spec.command === process.execPath) {
        if (behave.decode) return behave.decode(spec);
        const [, png, raw] = spec.args;
        const f = Number(/still-(\d+)\.png$/.exec(png!)![1]);
        writeFileSync(raw!, frameBytes(f));
        spec.onLine?.('{"ok":true}');
        return OK;
      }
      if (spec.args[0] !== "run") return OK;
      const inDir = mountOf(spec.args, "/in");
      const outDir = mountOf(spec.args, "/out");
      seen.video = readFileSync(path.join(inDir, "video.tsx"), "utf8");
      seen.props = readFileSync(path.join(inDir, "props.json"), "utf8");
      seen.meta = readFileSync(path.join(inDir, "meta.json"), "utf8");
      seen.asset = existsSync(path.join(inDir, "public", "pics", "a.png"));
      seen.entries.push(spec.args.slice(spec.args.indexOf("/opt/render/kit/render-entry.mjs")));
      if (spec.args.at(-1) === "--tsx-stills") {
        if (behave.stills) return behave.stills(outDir);
        for (const f of [0, 44, 89]) writeFileSync(path.join(outDir, `still-${f}.png`), "png");
        return OK;
      }
      if (behave.video) return behave.video(outDir);
      copyFileSync(GOOD_MP4, path.join(outDir, "out.mp4"));
      return OK;
    },
    ...over,
  };
}
const input = (over: Partial<Parameters<typeof renderTsx>[2]> = {}) => ({ source: SCENE, props: { title: "Hi" }, assets: { "pics/a.png": picture }, outFile: "tsx.mp4", ...over });
const runs = () => calls.filter((c) => c.args[0] === "run");
const failed = async (d: TsxRendererDeps, i = input()) => {
  const r = await renderTsx(d, ctx(), i);
  if (r.ok) throw new Error("expected a failure");
  return r.error;
};

describe("renderTsx", () => {
  it("stages the checked file, renders stills then the video under the same sandbox, and probes it", async () => {
    const r = await renderTsx(deps(), ctx(), input());
    expect(r).toEqual({ ok: true, outPath: path.join(attemptDir, "tsx.mp4"), image: "sha256:" + "b".repeat(64), stills: ["tsx-frame-first.png", "tsx-frame-middle.png", "tsx-frame-last.png"] });
    for (const f of ["first", "middle", "last"]) expect(existsSync(path.join(attemptDir, `tsx-frame-${f}.png`))).toBe(true); // kept, not deleted
    expect(seen.video).toBe(SCENE);
    expect(JSON.parse(seen.props!)).toEqual({ title: "Hi" });
    expect(JSON.parse(seen.meta!)).toEqual({ durationInFrames: 90, stills: [0, 44, 89], captions: [] });
    expect(seen.asset).toBe(true);
    expect(seen.entries).toEqual([
      ["/opt/render/kit/render-entry.mjs", "/in", "/out", "--tsx-stills"],
      ["/opt/render/kit/render-entry.mjs", "/in", "/out/out.mp4", "--tsx"],
    ]);
    const [a, b] = runs().map((c) => c.args);
    const flagsOf = (x: string[]) => x.slice(0, x.indexOf("--name")).concat(x.slice(x.indexOf("--name") + 2, x.indexOf("--label")));
    expect(flagsOf(a!)).toEqual(flagsOf(b!));
    for (const x of [a!, b!]) {
      expect(x[x.indexOf("--network") + 1]).toBe("none");
      expect(x).toContain("--read-only");
      expect(x[x.indexOf("--memory") + 1]).toBe("2048m");
      expect(x).toContain("core=0:0");
      expect(x.find((s) => s.endsWith(":/in:ro"))).toBeTruthy();
    }
    expect(runs().every((c) => c.timeoutMs === runs()[0]!.timeoutMs && c.timeoutMs <= 300_000)).toBe(true);
    for (const d of ["tsx-in", "tsx-out", "tsx-stills"]) expect(existsSync(path.join(attemptDir, d))).toBe(false);
  });

  it("refuses a file that fails the static check before anything runs", async () => {
    let typed = false;
    const e = await failed(deps({}, { typeCheck: async () => { typed = true; return { ok: true, problems: [] }; } }), input({ source: SCENE.replace("const frame", "fetch('/x'); const frame") }));
    expect(e.kind).toBe("check");
    expect(e.problems.join()).toMatch(/fetch/);
    expect(typed).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("type errors, a type-checker crash or a non-object answer fail closed", async () => {
    const long = `line 4: Type '${"x".repeat(80)}' is wrong`;
    let e = await failed(deps({}, { typeCheck: async () => ({ ok: false, problems: ["line 3: Cannot find name 'tittle'.", long] }) }));
    expect(e.kind).toBe("typecheck");
    expect(e.problems[0]).toBe("line 3: Cannot find name 'tittle'.");
    expect(e.problems[1]!.length).toBeLessThan(60);
    e = await failed(deps({}, { typeCheck: async () => { throw new Error("boom"); } }));
    expect(e.kind).toBe("typecheck");
    e = await failed(deps({}, { typeCheck: async () => ({ ok: "yes" }) as never }));
    expect(e.kind).toBe("typecheck");
    expect(calls).toHaveLength(0);
  });

  it("a failing preview render stops before the video; code frames are not echoed", async () => {
    const e = await failed(deps({
      stills: () => ({ ...OK, code: 1 }),
    }, {
      runChild: async (spec) => {
        calls.push(spec);
        if (spec.args[0] === "run") {
          for (const l of ["TypeError: x is not a function", "> 12 |   const opacity = interpolate(frame, [0, 30]);", "  13 | return"]) spec.onLine?.(l);
          return { ...OK, code: 1 };
        }
        return OK;
      },
    }));
    expect(e.kind).toBe("render");
    expect(e.problems).toEqual(["TypeError: x is not a function"]);
    expect(runs()).toHaveLength(1);
  });

  it("a preview that times out is a timeout", async () => {
    const e = await failed(deps({ stills: () => ({ ...OK, code: null, signal: "SIGKILL", timedOut: true }) }));
    expect(e.kind).toBe("timeout");
    expect(runs()).toHaveLength(1);
  });

  it("black, missing, symlinked or undecodable stills fail the preflight; the video never runs", async () => {
    let e = await failed(deps({ decode: (spec) => { writeFileSync(spec.args[2]!, Buffer.alloc(W * H * 3)); spec.onLine?.('{"ok":true}'); return OK; } }));
    expect(e.kind).toBe("preflight");
    expect(e.problems.join()).toMatch(/black/);
    e = await failed(deps({ decode: (spec) => { writeFileSync(spec.args[2]!, frameBytes(0)); spec.onLine?.('{"ok":true}'); return OK; } }));
    expect(e.problems.join()).toMatch(/nothing moves/);
    e = await failed(deps({ stills: () => OK }));
    expect(e.problems.join()).toMatch(/Frame 0 was not rendered/);
    e = await failed(deps({ stills: (outDir) => { for (const f of [0, 44, 89]) symlinkSync(picture, path.join(outDir, `still-${f}.png`)); return OK; } }));
    expect(e.problems.join()).toMatch(/was not rendered/);
    e = await failed(deps({ decode: (spec) => { spec.onLine?.('{"ok":false,"message":"The still could not be decoded."}'); return OK; } }));
    expect(e.problems.join()).toMatch(/could not be decoded/);
    e = await failed(deps({ decode: (spec) => { writeFileSync(spec.args[2]!, Buffer.alloc(10)); spec.onLine?.('{"ok":true}'); return OK; } }));
    expect(e.problems.join()).toMatch(/could not be decoded/);
    expect(runs().filter((c) => c.args.at(-1) === "--tsx")).toHaveLength(0);
    const decode = calls.find((c) => c.command === process.execPath)!;
    expect(decode.envAllow).toEqual(["PATH"]);
    expect(decode.args[0]).toMatch(/still-child\.mjs$/);
  });

  it("a missing, wrong-size or wrong-length video fails the output check", async () => {
    expect((await failed(deps({ video: () => OK }))).kind).toBe("output");
    expect((await failed(deps({}, { probe: async () => ({ width: 1920, height: 1080, durationS: 3, hasAudio: false, meanDb: null, peakDb: null, loopDiff: 1 }) }))).message).toMatch(/1920x1080/);
    expect((await failed(deps({}, { probe: async () => ({ width: W, height: H, durationS: 9, hasAudio: false, meanDb: null, peakDb: null, loopDiff: 1 }) }))).message).toMatch(/meta says 3\.0 s/);
    expect((await failed(deps({}, { probe: async () => { throw new Error("x"); } }))).message).toMatch(/not a readable video/);
  });

  it("bad assets, props or out names are refused before docker", async () => {
    const bads: Record<string, string>[] = [{ "../a.png": picture }, { "a.svg": picture }, { "a.png": "relative.png" }, { "a.png": path.join(root, "missing.png") }];
    for (const assets of bads) {
      expect((await failed(deps(), input({ assets }))).kind).toBe("infra");
    }
    expect((await failed(deps(), input({ props: { big: "x".repeat(70_000) } }))).message).toMatch(/64 KB/);
    expect((await failed(deps(), input({ props: [] as never }))).kind).toBe("infra");
    await expect(renderTsx(deps(), ctx(), input({ outFile: "../x.mp4" }))).rejects.toThrow(/plain file name/);
    expect(runs()).toHaveLength(0);
  });

  it("a cancelled stage throws instead of returning a model error", async () => {
    await expect(renderTsx(deps({ stills: () => { ac.abort(new Error("stop")); return { ...OK, code: null, aborted: true }; } }), ctx(), input())).rejects.toThrow("stop");
  });
});

describe("renderTsx frame review", () => {
  const writeStills = (outDir: string) => {
    for (const f of [0, 20, 44, 60, 89]) writeFileSync(path.join(outDir, `still-${f}.png`), "png");
    return OK;
  };
  const decode = (spec: ChildSpec) => {
    const [, png, raw, , , jpg] = spec.args;
    const f = Number(/still-(\d+)\.png$/.exec(png!)![1]);
    writeFileSync(raw!, frameBytes(f));
    if (jpg) writeFileSync(jpg, Buffer.from([0xff, 0xd8, f]));
    spec.onLine?.('{"ok":true}');
    return OK;
  };

  it("renders the beat midpoints too, hands the JPEGs to the review, and renders the video when it finds nothing", async () => {
    let got: number[] = [];
    const r = await renderTsx(deps({ stills: writeStills, decode }), ctx(), input({ reviewAt: [20, 60, 60], review: async (shots) => { got = shots.map((s) => s.frame); return null; } }));
    expect(r.ok).toBe(true);
    expect(got).toEqual([0, 20, 44, 60, 89]);
    expect(JSON.parse(seen.meta!).stills).toEqual([0, 20, 44, 60, 89]);
    expect(runs().some((c) => c.args.at(-1) === "--tsx")).toBe(true);
  });

  it("review problems stop before the video render and come back as a 'review' failure", async () => {
    const e = await failed(deps({ stills: writeStills, decode }), input({ reviewAt: [20, 60], review: async () => ["frame 20: object too small"] }));
    expect(e.kind).toBe("review");
    expect(e.problems).toEqual(["frame 20: object too small"]);
    expect(runs().some((c) => c.args.at(-1) === "--tsx")).toBe(false);
  });

  it("a review that throws (budget, unclear outcome) goes up untouched; no review means three stills and no JPEG", async () => {
    await expect(renderTsx(deps({ stills: writeStills, decode }), ctx(), input({ review: async () => { throw new Error("unclear"); } }))).rejects.toThrow("unclear");
    calls = [];
    const r = await renderTsx(deps(), ctx(), input());
    expect(r.ok).toBe(true);
    expect(JSON.parse(seen.meta!).stills).toEqual([0, 44, 89]);
    expect(calls.filter((c) => c.command === process.execPath).every((c) => c.args.length === 5)).toBe(true);
  });
});

describe("scrub", () => {
  it("shortens long quotes, hides lines that repeat the source, keeps plain text", () => {
    expect(scrub("line 2: Cannot find name 'x'.", SCENE)).toBe("line 2: Cannot find name 'x'.");
    expect(scrub(`bad '${"ab ".repeat(20)}'`, SCENE)).toBe(`bad '${"ab ".repeat(9)}...'`);
    expect(scrub("key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789", SCENE)).not.toMatch(/abcdefghij/);
    expect(scrub("at   const opacity = interpolate(frame, [0, 30], [0, 1]", SCENE)).toMatch(/hidden/);
    expect(scrub("é\u0000ok", SCENE)).toBe("??ok");
    expect(scrub("zz ".repeat(400), SCENE)).toHaveLength(300);
  });
});
