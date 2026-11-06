import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildEngineConfig } from "@/server/core/engine-config";
import { KnownFailure } from "@/server/core/paid-call";
import { sceneCodeSha, type SceneProps } from "@/server/core/scene3d-code-body";
import { sceneProps } from "@/server/core/scene3d-author-prompt";
import type { StageContext } from "@/server/core/stage-handler";
import type { ChildResult, ChildSpec } from "@/server/render/child";
import { createContainerRenderer } from "@/server/providers/renderer/remotion-container";
import { allowBackProblem, coversPath, createNativeRenderer, type NativeRendererDeps } from "@/server/providers/renderer/remotion-native";
import { buildSandboxProfile } from "@/server/providers/renderer/native-sandbox";
import { sha256Hex } from "@/shared/assets3d/files";
import { sha256Hex as textSha } from "@/server/core/content-hash";
import { loadCatalog } from "@/shared/assets3d/catalog";
import { FAKE_ENTRIES } from "../support/catalog3d";

// The scene3d_code branch of the native renderer: what it stages, what it refuses BEFORE anything starts. No real render, no sandbox-exec.
const GOOD = path.resolve("tests/fixtures/video/good.mp4");
const SIZE = { width: 1080, height: 1920 };
const DONE: ChildResult = { code: 0, signal: null, truncated: false, timedOut: false, aborted: false };
const GLB = Buffer.concat([Buffer.from("glTF"), Buffer.alloc(40, 7)]);
const SOURCE = `import { World, useModels } from "s3k";
import type { SceneProps } from "s3k";
export default function Scene({ resolver }: SceneProps) {
  const models = useModels(["pp_ship"], resolver);
  return models ? <World focus={{ min: [0, 0, 0], max: [1, 1, 1] }} /> : null;
}
`;
const BEATS = [{ id: "hook", line: "A ship carries sand to the shore.", visual: "ship", from: 0, to: 4 }, { id: "loop", line: "Then it pours it out.", visual: "pour", from: 4, to: 8.5 }];
const PROPS: SceneProps = sceneProps(BEATS, 8.5);

let root: string, attemptDir: string, assets: string, calls: ChildSpec[], ac: AbortController;
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "rn3c-")));
  attemptDir = path.join(root, "videos", "v1", "attempt-r1-1");
  assets = path.join(root, "assets-files");
  mkdirSync(attemptDir, { recursive: true });
  mkdirSync(assets, { recursive: true });
  calls = [];
  ac = new AbortController();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const catalog = (over: Record<string, unknown> = {}) => loadCatalog({ version: 1, entries: FAKE_ENTRIES.map((e) => ({ ...e, sha256: sha256Hex(GLB), source_sha256: sha256Hex(GLB), bytes: GLB.length, ...(e.id === "pp_ship" ? over : {}) })) });
const ctx = (native = true): StageContext =>
  ({
    stage: { name: "render", videoId: "v1" }, claim: { stageRunId: "run-1", fence: 1 }, config: buildEngineConfig(new Map<string, unknown>([["render.native_3d", native]])), signal: ac.signal, attemptDir,
    log: () => undefined, progress: () => undefined, nextStep: () => 0, paid: async () => { throw new Error("no paid calls"); },
  }) as unknown as StageContext;
const modeIdx = (spec: ChildSpec) => spec.args.indexOf("--native") - 1;
const inDirOf = (spec: ChildSpec) => spec.args[modeIdx(spec) - 2]!;
const outFileOf = (spec: ChildSpec) => spec.args[modeIdx(spec) - 1]!;
function deps(behave?: (spec: ChildSpec) => ChildResult, over: Partial<NativeRendererDeps> = {}): NativeRendererDeps {
  return {
    root, kitDir: path.resolve("remotion/kit"), homeDir: root, assetsDir: assets, catalog: async () => catalog(),
    preflight: async () => ({ ready: true, message: "Ready", chromeDir: path.resolve("tests/fixtures") }),
    probe: async () => ({ width: 1080, height: 1920, durationS: 8.9, hasAudio: false, meanDb: -20, peakDb: -1, loopDiff: 1 }),
    runChild: async (spec) => {
      calls.push(spec);
      if (behave) return behave(spec);
      copyFileSync(GOOD, outFileOf(spec));
      return DONE;
    },
    typeCheck: (s) => ({ ok: true, problems: [], sha256: textSha(s) }),
    ...over,
  };
}
const input = (over: Partial<{ source: string; props: SceneProps; expectedSha256: string }> = {}) => {
  const source = over.source ?? SOURCE;
  const props = over.props ?? PROPS;
  return { source, props, expectedSha256: over.expectedSha256 ?? sceneCodeSha(source, props) };
};
const args = (over: object = {}) => ({ sceneFile: "unused", scene3dCode: input(), outFile: "render.mp4", size: SIZE, ...over });

describe("native renderer, scene3d_code", () => {
  it("runs render-entry with --scene3d-code --native, staging ONLY scene.tsx, props.json and the models the scene names", async () => {
    writeFileSync(path.join(assets, "pp_ship.glb"), GLB);
    writeFileSync(path.join(assets, "pp_crane.glb"), GLB); // in the folder but not named by the scene: must NOT be staged
    let seen: { files: string[]; props: Record<string, unknown>; scene: string; models: string[] } | undefined;
    const r = await createNativeRenderer(
      deps((spec) => {
        const dir = inDirOf(spec);
        seen = { files: readdirSync(dir).sort(), props: JSON.parse(readFileSync(path.join(dir, "props.json"), "utf8")), scene: readFileSync(path.join(dir, "scene.tsx"), "utf8"), models: readdirSync(path.join(dir, "models")) };
        copyFileSync(GOOD, outFileOf(spec));
        return DONE;
      }),
    ).render(ctx(), args());
    expect(r.outPath).toBe(path.join(attemptDir, "render.mp4"));
    expect(calls[0]!.args.slice(-4)).toEqual(["--scene3d-code", "--native", "--expect-sha", textSha(SOURCE)]); // render-entry hashes scene.tsx before bundling
    expect(calls[0]!.envAllow).toEqual([]);
    expect(seen!.files).toEqual(["models", "props.json", "scene.tsx"]);
    expect(seen!.scene).toBe(SOURCE);
    expect(seen!.models).toEqual(["pp_ship.glb"]);
    expect(Object.keys(seen!.props).sort()).toEqual(["beats", "captions", "durationS", "frames", "models"]);
    expect(seen!.props.models).toEqual({ pp_ship: "models/pp_ship.glb" });
    expect(seen!.props.frames).toBe(Math.round(PROPS.durationS * 30));
    // the sandbox profile is the same one the director's 3D scenes get: nothing of the repo, the storage root or the models folder is readable
    expect(calls[0]!.args[4]).not.toContain(assets);
    expect(calls[0]!.args[4]).toMatch(/\(deny network\*\)/);
    expect(existsSync(path.join(attemptDir, "native-in"))).toBe(false);
  });

  it("does not loosen the sandbox profile for this mode (same text for the same folders)", () => {
    const p = { repoRoot: "/r", kitDir: "/r/remotion/kit", nodeModules: "/r/node_modules", storageRoot: "/s", homeDir: "/h", inDir: "/s/in", outDir: "/s/out", tmpDir: "/s/tmp", nodePrefix: "/n", chromeDir: "/c" };
    expect(buildSandboxProfile(p)).toBe(buildSandboxProfile({ ...p }));
    expect(readFileSync("src/server/providers/renderer/native-sandbox.ts", "utf8")).not.toMatch(/--scene3d-code[^\n]*(allow|network)/);
  });

  it("REFUSES a source that differs from the approved fingerprint, before anything is written or started", async () => {
    writeFileSync(path.join(assets, "pp_ship.glb"), GLB);
    const tampered = input({ source: `${SOURCE}// changed\n`, expectedSha256: sceneCodeSha(SOURCE, PROPS) });
    await expect(createNativeRenderer(deps()).render(ctx(), args({ scene3dCode: tampered }))).rejects.toThrow(/not the one you approved/);
    const props = input({ props: { ...PROPS, durationS: 9 }, expectedSha256: sceneCodeSha(SOURCE, PROPS) });
    await expect(createNativeRenderer(deps()).render(ctx(), args({ scene3dCode: props }))).rejects.toThrow(/not the one you approved/);
    expect(calls).toHaveLength(0);
    expect(existsSync(path.join(attemptDir, "native-in"))).toBe(false);
  });

  it("re-runs the checker on the source and refuses a hostile one even when its fingerprint matches", async () => {
    writeFileSync(path.join(assets, "pp_ship.glb"), GLB);
    const evil = `import { World } from "s3k";\nexport default function Scene() { fetch("http://127.0.0.1:3000/api"); return <World focus={{ min: [0, 0, 0], max: [1, 1, 1] }} />; }\n`;
    const err = await createNativeRenderer(deps()).render(ctx(), args({ scene3dCode: input({ source: evil }) })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KnownFailure);
    expect((err as Error).message).toMatch(/failed the safety check again.*"fetch" is not available/);
    expect(calls).toHaveLength(0);
  });

  it("the type-check runs again on the staged bytes and any failure, timeout, crash or other bytes stops everything before a process starts", async () => {
    writeFileSync(path.join(assets, "pp_ship.glb"), GLB);
    for (const tc of [
      () => { throw new Error("boom"); },
      () => ({ ok: false, problems: ["line 1: type error: x"], sha256: textSha(SOURCE) }),
      () => ({ ok: false, fatal: true, problems: ["type-check: took longer"], sha256: textSha(SOURCE) }),
      () => ({ ok: true, problems: [], sha256: textSha("different") }),
      () => ({ ok: true, problems: [] }),
    ]) {
      await expect(createNativeRenderer(deps(undefined, { typeCheck: tc })).render(ctx(), args())).rejects.toThrow(/did not pass the type-check again/);
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses props that make a film longer than 75 s", async () => {
    const long: SceneProps = { ...PROPS, durationS: 80 };
    await expect(createNativeRenderer(deps()).render(ctx(), args({ scene3dCode: input({ props: long }) }))).rejects.toThrow(/the most is 75 s/);
    expect(calls).toHaveLength(0);
  });

  it("a model file that does not match the catalogue is refused; an unknown id is simply not staged", async () => {
    writeFileSync(path.join(assets, "pp_ship.glb"), GLB);
    await expect(createNativeRenderer(deps(undefined, { catalog: async () => catalog({ sha256: "b".repeat(64), source_sha256: "b".repeat(64) }) })).render(ctx(), args())).rejects.toThrow(/does not match the catalogue/);
    expect(calls).toHaveLength(0);
    let staged: string[] | undefined;
    const noModels = input({ source: SOURCE.replace("pp_ship", "pp_unicorn") });
    await createNativeRenderer(deps((spec) => { staged = existsSync(path.join(inDirOf(spec), "models")) ? readdirSync(path.join(inDirOf(spec), "models")) : []; copyFileSync(GOOD, outFileOf(spec)); return DONE; })).render(ctx(), args({ scene3dCode: noModels }));
    expect(staged).toEqual([]);
  });

  it("still needs render.native_3d, a ready preflight and the catalogue; the container never draws it", async () => {
    writeFileSync(path.join(assets, "pp_ship.glb"), GLB);
    await expect(createNativeRenderer(deps()).render(ctx(false), args())).rejects.toThrow(/switched off in Settings/);
    await expect(createNativeRenderer(deps(undefined, { catalog: undefined })).render(ctx(), args())).rejects.toThrow(/catalogue could not be read/);
    await expect(createContainerRenderer({} as never).render(ctx(), args() as never)).rejects.toThrow(/Mac's GPU only/);
    expect(calls).toHaveLength(0);
  });
});

describe("native renderer, scene3d_code preview pictures", () => {
  const png = () => {
    const b = Buffer.alloc(53);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
    b.writeUInt32BE(13, 8);
    b.write("IHDR", 12, "ascii");
    b.writeUInt32BE(540, 16);
    b.writeUInt32BE(960, 20);
    return b;
  };
  const draws = (spec: ChildSpec): ChildResult => {
    const frames = (JSON.parse(readFileSync(path.join(inDirOf(spec), "stills.json"), "utf8")) as { frames: number[] }).frames;
    frames.forEach((_, i) => writeFileSync(path.join(outFileOf(spec), `still-${String(i + 1).padStart(2, "0")}.png`), png()));
    return DONE;
  };
  it("runs --scene3d-code-stills on the out FOLDER with the same staging and checks, and copies the pictures", async () => {
    writeFileSync(path.join(assets, "pp_ship.glb"), GLB);
    let files: string[] = [];
    const r = await createNativeRenderer(deps((spec) => { files = readdirSync(inDirOf(spec)).sort(); return draws(spec); })).stills(ctx(), { scene3dCode: input(), frames: [15, 90] });
    expect(r.files).toEqual(["stills/01.png", "stills/02.png"]);
    expect(calls[0]!.args.slice(-4)).toEqual(["--scene3d-code-stills", "--native", "--expect-sha", textSha(SOURCE)]);
    expect(outFileOf(calls[0]!)).toBe(path.join(attemptDir, "native-out"));
    expect(files).toEqual(["models", "props.json", "scene.tsx", "stills.json"]);
  });
  it("refuses a tampered or hostile scene, and a call that gives both or neither scene", async () => {
    writeFileSync(path.join(assets, "pp_ship.glb"), GLB);
    await expect(createNativeRenderer(deps(draws)).stills(ctx(), { scene3dCode: input({ source: `${SOURCE}//x\n`, expectedSha256: sceneCodeSha(SOURCE, PROPS) }), frames: [1] })).rejects.toThrow(/not the one you approved/);
    await expect(createNativeRenderer(deps(draws)).stills(ctx(), { scene3dCode: input({ source: `eval("1");\nexport default function S() { return null; }\n` }), frames: [1] })).rejects.toThrow(/safety check again/);
    await expect(createNativeRenderer(deps(draws)).stills(ctx(), { frames: [1] })).rejects.toThrow(/exactly one/);
    expect(calls).toHaveLength(0);
  });
});

describe("allow-back folders must not reopen the home folder, the repo or the storage root", () => {
  it("coversPath: equal or ancestor only", () => {
    expect(coversPath("/Users/me", "/Users/me/app")).toBe(true);
    expect(coversPath("/Users/me/app", "/Users/me/app")).toBe(true);
    expect(coversPath("/Users/me/app/node_modules", "/Users/me/app")).toBe(false);
    expect(coversPath("/usr/local", "/Users/me")).toBe(false);
  });
  it("names the folder and the closed folder, key sentence first", () => {
    expect(allowBackProblem({ "node install": "/Users/me" }, { home: "/Users/me", app: "/Users/me/app" })).toMatch(/^The node install folder \(\/Users\/me\) contains your home folder/);
    expect(allowBackProblem({ "node install": "/usr/local", Chrome: "/Users/me/app/node_modules/.remotion/x" }, { home: "/Users/me", app: "/Users/me/app" })).toBeNull();
  });
  it("the renderer refuses to start when node lives directly under the home folder", async () => {
    writeFileSync(path.join(assets, "pp_ship.glb"), GLB);
    const home = path.dirname(path.dirname(realpathSync(process.execPath)));
    await expect(createNativeRenderer(deps(undefined, { homeDir: home })).render(ctx(), args())).rejects.toThrow(/contains your home folder/);
    expect(calls).toHaveLength(0);
  });
});

describe("disk quota", () => {
  it("a failed size measurement kills the render (fail closed)", async () => {
    writeFileSync(path.join(assets, "pp_ship.glb"), GLB);
    const waiting = (spec: ChildSpec): Promise<ChildResult> => new Promise((resolve) => {
      calls.push(spec);
      spec.signal?.addEventListener("abort", () => resolve({ ...DONE, aborted: true, code: null }));
    });
    await expect(createNativeRenderer(deps(undefined, { runChild: waiting, dirSize: async () => { throw new Error("du failed"); }, quotaPollMs: 5 })).render(ctx(), args())).rejects.toThrow(/could not be measured/);
  });
  it("removes the abort listener even when the child runner throws", async () => {
    writeFileSync(path.join(assets, "pp_ship.glb"), GLB);
    let added = 0, removed = 0;
    const add = ac.signal.addEventListener.bind(ac.signal), rem = ac.signal.removeEventListener.bind(ac.signal);
    ac.signal.addEventListener = ((...a: Parameters<typeof add>) => (added++, add(...a))) as typeof add;
    ac.signal.removeEventListener = ((...a: Parameters<typeof rem>) => (removed++, rem(...a))) as typeof rem;
    await expect(createNativeRenderer(deps(undefined, { runChild: async () => { throw new Error("spawn failed"); } })).render(ctx(), args())).rejects.toThrow(/spawn failed/);
    expect(added).toBeGreaterThan(0);
    expect(removed).toBe(added);
  });
  it("measures the job folders and kills the process group when they pass the cap, with a key-first sentence", async () => {
    writeFileSync(path.join(assets, "pp_ship.glb"), GLB);
    let killed = false;
    const waiting = (spec: ChildSpec): Promise<ChildResult> => new Promise((resolve) => {
      calls.push(spec);
      spec.signal?.addEventListener("abort", () => { killed = true; resolve({ ...DONE, aborted: true, code: null }); });
    });
    const seen: string[][] = [];
    const err = await createNativeRenderer(deps(undefined, { runChild: waiting, dirSize: async (d) => (seen.push([...d]), 7 * 1024 ** 3), quotaBytes: 6 * 1024 ** 3, quotaPollMs: 5 })).render(ctx(), args()).catch((e: unknown) => e);
    expect(killed).toBe(true);
    expect(err).toBeInstanceOf(KnownFailure);
    expect((err as Error).message).toMatch(/^The render wrote more than 6 GB of files and was stopped\./);
    expect(seen[0]!.map((x) => path.basename(x))).toEqual(["native-in", "native-out", "native-tmp"]);
    expect(existsSync(path.join(attemptDir, "native-in"))).toBe(false);
  });
  it("a render under the cap, and the caller's own abort, are not mistaken for it", async () => {
    writeFileSync(path.join(assets, "pp_ship.glb"), GLB);
    await createNativeRenderer(deps(undefined, { dirSize: async () => 1024, quotaPollMs: 5 })).render(ctx(), args());
    expect(calls).toHaveLength(1);
    ac.abort(new Error("owner cancelled"));
    await expect(createNativeRenderer(deps(() => ({ ...DONE, aborted: true, code: null }))).render(ctx(), args())).rejects.toThrow(/owner cancelled/);
  });
});

describe("render-entry.mjs, authored scenes", () => {
  const entry = readFileSync("remotion/kit/render-entry.mjs", "utf8");
  it("accepts --scene3d-code and --scene3d-code-stills only with exactly --native (then an optional --expect-sha), and the sha is mandatory for them", () => {
    expect(entry).toContain('mode === "--scene3d-code" || mode === "--scene3d-code-stills") && extra.length === 1 && extra[0] === "--native"');
    expect(entry).toContain('((mode === "--scene3d" || mode === "--scene3d-stills" || mode === "--scene3d-code" || mode === "--scene3d-code-stills") && !native)');
    expect(entry).toContain("!expectSha ||");
  });
  it("the registry never imports the staged scene, so no other bundle can contain untrusted code", () => {
    expect(readFileSync("remotion/kit/registry.tsx", "utf8")).not.toMatch(/s3k-scene|s3k\/Author/);
    expect(readFileSync("remotion/kit/s3k/Author.tsx", "utf8")).toContain('from "s3k-scene"');
  });
});
