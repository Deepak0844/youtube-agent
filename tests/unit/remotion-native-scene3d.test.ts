import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildEngineConfig } from "@/server/core/engine-config";
import { KnownFailure } from "@/server/core/paid-call";
import type { StageContext } from "@/server/core/stage-handler";
import type { ChildResult, ChildSpec } from "@/server/render/child";
import { createContainerRenderer } from "@/server/providers/renderer/remotion-container";
import { createNativeRenderer, type NativeRendererDeps } from "@/server/providers/renderer/remotion-native";
import { sha256Hex } from "@/shared/assets3d/files";
import { loadCatalog } from "@/shared/assets3d/catalog";
import { scene3dSchema, type Scene3d } from "@/shared/scene3d";
import { FAKE_ENTRIES } from "../support/catalog3d";

// The scene3d branch of the native renderer: command, props and the models it stages. No real render, no sandbox-exec.
const GOOD = path.resolve("tests/fixtures/video/good.mp4");
const SIZE = { width: 1080, height: 1920 };
const DONE: ChildResult = { code: 0, signal: null, truncated: false, timedOut: false, aborted: false };
const GLB = Buffer.concat([Buffer.from("glTF"), Buffer.alloc(40, 7)]);

let root: string;
let attemptDir: string;
let assets: string;
let calls: ChildSpec[];
let ac: AbortController;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "rn3-")));
  attemptDir = path.join(root, "videos", "v1", "attempt-r1-1");
  assets = path.join(root, "assets-files");
  mkdirSync(attemptDir, { recursive: true });
  mkdirSync(assets, { recursive: true });
  calls = [];
  ac = new AbortController();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const catalog = (over: Record<string, unknown> = {}) =>
  loadCatalog({ version: 1, entries: FAKE_ENTRIES.map((e) => ({ ...e, sha256: sha256Hex(GLB), source_sha256: sha256Hex(GLB), bytes: GLB.length, ...(e.id === "pp_ship" ? over : {}) })) });
const putModel = (name: string) => writeFileSync(path.join(assets, name), GLB);

const ctx = (native = true): StageContext =>
  ({
    stage: { name: "render", videoId: "v1" }, claim: { stageRunId: "run-1", fence: 1 }, config: buildEngineConfig(new Map<string, unknown>([["render.native_3d", native]])), signal: ac.signal, attemptDir,
    log: () => undefined, progress: () => undefined, nextStep: () => 0, paid: async () => { throw new Error("no paid calls"); },
  }) as unknown as StageContext;

const scene = (): Scene3d =>
  scene3dSchema.parse({
    version: 2,
    elements: [
      { kind: "water", id: "sea", size_m: [400, 200] },
      { kind: "model", id: "barge", model: { catalog: "pp_ship" }, height_m: 20 },
      { kind: "model", id: "barge2", model: { catalog: "pp_ship" }, height_m: 10, at: { x: 30 } },
    ],
    shots: [{ id: "hook", duration_s: 5, focus: "barge" }],
  });

const modeIdx = (spec: ChildSpec) => spec.args.indexOf("--native") - 1;
const inDirOf = (spec: ChildSpec) => spec.args[modeIdx(spec) - 2]!;
const outFileOf = (spec: ChildSpec) => spec.args[modeIdx(spec) - 1]!;

function deps(behave?: (spec: ChildSpec) => ChildResult, over: Partial<NativeRendererDeps> = {}): NativeRendererDeps {
  return {
    root, kitDir: path.resolve("remotion/kit"), homeDir: root, assetsDir: assets, catalog: async () => catalog(),
    preflight: async () => ({ ready: true, message: "Ready", chromeDir: path.resolve("tests/fixtures") }),
    probe: async () => ({ width: 1080, height: 1920, durationS: 5, hasAudio: false, meanDb: -20, peakDb: -1, loopDiff: 1 }),
    runChild: async (spec) => {
      calls.push(spec);
      if (behave) return behave(spec);
      copyFileSync(GOOD, outFileOf(spec));
      return DONE;
    },
    ...over,
  };
}
const args = (over: object = {}) => ({ sceneFile: "unused", scene3d: scene(), outFile: "render.mp4", size: SIZE, ...over });

describe("native renderer, scene3d", () => {
  it("runs render-entry with --scene3d --native and stages only the models the scene names, as {file: models/...}", async () => {
    putModel("pp_ship.glb");
    putModel("pp_crane.glb"); // in the folder but not in the scene: must NOT be staged
    let seen: { props: { scene: Scene3d }; staged: string[] } | undefined;
    const r = await createNativeRenderer(
      deps((spec) => {
        seen = { props: JSON.parse(readFileSync(path.join(inDirOf(spec), "props.json"), "utf8")), staged: readdirSync(path.join(inDirOf(spec), "models")) };
        copyFileSync(GOOD, outFileOf(spec));
        return DONE;
      }),
    ).render(ctx(), args());
    expect(r.outPath).toBe(path.join(attemptDir, "render.mp4"));
    expect(calls[0]!.args.slice(-2)).toEqual(["--scene3d", "--native"]);
    expect(calls[0]!.envAllow).toEqual([]);
    expect(seen!.staged).toEqual(["pp_ship.glb"]);
    const models = seen!.props.scene.elements.filter((e) => e.kind === "model").map((e) => (e.kind === "model" ? e.model : null));
    expect(models).toEqual([{ file: "models/pp_ship.glb" }, { file: "models/pp_ship.glb" }]);
    expect(Object.keys(seen!.props)).toEqual(["scene"]);
    // the sandbox profile still reads nothing of the repo or the models folder
    expect(calls[0]!.args[4]).not.toContain(assets);
    expect(existsSync(path.join(attemptDir, "native-in"))).toBe(false);
  });

  it("a model file that is not there is a plain failure naming assets3d:fetch, and nothing starts", async () => {
    await expect(createNativeRenderer(deps()).render(ctx(), args())).rejects.toThrow(/assets3d:fetch/);
    expect(calls).toHaveLength(0);
  });

  it("a model file that does not match the catalogue (checksum) is refused", async () => {
    putModel("pp_ship.glb");
    await expect(createNativeRenderer(deps(undefined, { catalog: async () => catalog({ sha256: "b".repeat(64), source_sha256: "b".repeat(64) }) })).render(ctx(), args())).rejects.toThrow(/does not match the catalogue/);
    expect(calls).toHaveLength(0);
  });

  it("refuses a model id the catalogue does not have, and a missing catalogue", async () => {
    const bad = scene3dSchema.parse({ version: 2, elements: [{ kind: "model", id: "x", model: { catalog: "pp_unicorn" }, height_m: 3 }], shots: [{ id: "hook", duration_s: 5, focus: "x" }] });
    await expect(createNativeRenderer(deps()).render(ctx(), args({ scene3d: bad }))).rejects.toThrow(KnownFailure);
    await expect(createNativeRenderer(deps(undefined, { catalog: undefined })).render(ctx(), args())).rejects.toThrow(/catalogue could not be read/);
    expect(calls).toHaveLength(0);
  });

  it("still refuses when native_3d is off", async () => {
    putModel("pp_ship.glb");
    await expect(createNativeRenderer(deps()).render(ctx(false), args())).rejects.toThrow(/switched off in Settings/);
    expect(calls).toHaveLength(0);
  });

  it("the container renderer never draws a 3D scene", async () => {
    await expect(createContainerRenderer({} as never).render(ctx(), args() as never)).rejects.toThrow(/Mac's GPU only/);
  });
});

// The preview pictures (--scene3d-stills): same job, same checks, PNG files instead of an mp4.
describe("native renderer, scene3d preview pictures", () => {
  const png = (w = 540, h = 960, pad = 20) => {
    const b = Buffer.alloc(33 + pad);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
    b.writeUInt32BE(13, 8);
    b.write("IHDR", 12, "ascii");
    b.writeUInt32BE(w, 16);
    b.writeUInt32BE(h, 20);
    return b;
  };
  const framesOf = (spec: ChildSpec): number[] => (JSON.parse(readFileSync(path.join(inDirOf(spec), "stills.json"), "utf8")) as { frames: number[] }).frames;
  /** Writes still-NN.png for every requested frame, like render-entry.mjs does. */
  const draws = (make: (i: number) => Buffer | null = () => png()) => (spec: ChildSpec): ChildResult => {
    framesOf(spec).forEach((_, i) => {
      const b = make(i + 1);
      if (b) writeFileSync(path.join(outFileOf(spec), `still-${String(i + 1).padStart(2, "0")}.png`), b);
    });
    return DONE;
  };
  const run = (behave?: (spec: ChildSpec) => ChildResult, frames = [15, 90, 200], over: Partial<NativeRendererDeps> = {}, native = true) =>
    createNativeRenderer(deps(behave ?? draws(), over)).stills(ctx(native), { scene3d: scene(), frames });

  it("runs render-entry with --scene3d-stills --native on the out FOLDER, stages only the named models, and copies the pictures to stills/NN.png", async () => {
    putModel("pp_ship.glb");
    putModel("pp_crane.glb");
    let seen: { props: { scene: Scene3d }; staged: string[]; frames: number[] } | undefined;
    const r = await run((spec) => {
      seen = { props: JSON.parse(readFileSync(path.join(inDirOf(spec), "props.json"), "utf8")), staged: readdirSync(path.join(inDirOf(spec), "models")), frames: framesOf(spec) };
      return draws()(spec);
    });
    expect(r.files).toEqual(["stills/01.png", "stills/02.png", "stills/03.png"]);
    for (const f of r.files) expect(existsSync(path.join(attemptDir, f))).toBe(true);
    expect(calls[0]!.args.slice(-2)).toEqual(["--scene3d-stills", "--native"]);
    expect(outFileOf(calls[0]!)).toBe(path.join(attemptDir, "native-out"));
    expect(calls[0]!.envAllow).toEqual([]);
    expect(seen!.staged).toEqual(["pp_ship.glb"]);
    expect(seen!.frames).toEqual([15, 90, 200]);
    expect(Object.keys(seen!.props)).toEqual(["scene"]);
    expect(existsSync(path.join(attemptDir, "native-in"))).toBe(false);
    expect(existsSync(path.join(attemptDir, "native-out"))).toBe(false);
  });

  it("refuses when native_3d is off or the preflight is not ready, and nothing starts", async () => {
    putModel("pp_ship.glb");
    await expect(run(undefined, undefined, undefined, false)).rejects.toThrow(/switched off in Settings/);
    await expect(run(undefined, undefined, { preflight: async () => ({ ready: false, message: "Not ready: no shell.", chromeDir: null }) })).rejects.toThrow(/Not ready: no shell/);
    expect(calls).toHaveLength(0);
  });

  it("refuses a picture that is not a PNG, one of the wrong size, one that is missing, and one that is too big", async () => {
    putModel("pp_ship.glb");
    await expect(run(draws((i) => (i === 2 ? Buffer.from("<svg onload=alert(1)>............") : png())))).rejects.toThrow(/picture 2 is not a PNG/);
    await expect(run(draws((i) => (i === 1 ? png(1080, 1920) : png())))).rejects.toThrow(/picture 1 is 1080x1920/);
    await expect(run(draws((i) => (i === 3 ? null : png())))).rejects.toThrow(/picture 3 was not drawn/);
    await expect(run(draws((i) => (i === 1 ? png(540, 960, 2 * 1024 * 1024 + 10) : png())))).rejects.toThrow(/picture 1 was not drawn, or is bigger than 2 MB/);
    expect(existsSync(path.join(attemptDir, "native-out"))).toBe(false);
  });

  it("asks for 1 to 8 whole frames only", async () => {
    putModel("pp_ship.glb");
    await expect(run(undefined, [])).rejects.toThrow(/1 to 8/);
    await expect(run(undefined, [1, 2, 3, 4, 5, 6, 7, 8, 9])).rejects.toThrow(/1 to 8/);
    await expect(run(undefined, [1.5])).rejects.toThrow(/whole frame/);
    await expect(run(undefined, [-1])).rejects.toThrow(/whole frame/);
    expect(calls).toHaveLength(0);
  });

  it("a model that does not match the catalogue stops the pictures too", async () => {
    putModel("pp_ship.glb");
    await expect(run(undefined, undefined, { catalog: async () => catalog({ sha256: "b".repeat(64), source_sha256: "b".repeat(64) }) })).rejects.toThrow(/does not match the catalogue/);
    expect(calls).toHaveLength(0);
  });
});
