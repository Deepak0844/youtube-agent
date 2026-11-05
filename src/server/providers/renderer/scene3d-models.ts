import { copyFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { KnownFailure } from "@/server/core/paid-call";
import { loadCatalog, type Catalog3d } from "@/shared/assets3d/catalog";
import { ALLOWED_LICENSES } from "@/shared/assets3d/schema";
import { checkFile } from "@/shared/assets3d/files";
import type { Scene3d } from "@/shared/scene3d";
import { checkScene3dCode, sceneModelIds } from "@/server/core/scene3d-code-check";
import { sceneCodeSha } from "@/server/core/scene3d-code-body";
import { sha256Hex } from "@/server/core/content-hash";
import type { Scene3dCodeInput } from "./index";

// The CC0 model catalogue as the host sees it: the manifest in the repo, and the model files that `npm run assets3d:fetch` put in assets3d/files/.

const cache = new Map<string, Promise<Catalog3d>>();

/** Reads and checks <repoRoot>/assets3d/manifest.json once per process. */
export function loadRepoCatalog(repoRoot: string): Promise<Catalog3d> {
  const file = path.join(repoRoot, "assets3d", "manifest.json");
  let p = cache.get(file);
  if (!p) {
    p = readFile(file, "utf8").then((t) => loadCatalog(JSON.parse(t)));
    p.catch(() => cache.delete(file));
    cache.set(file, p);
  }
  return p;
}

/** Where the staged models sit inside the render's in folder (the composition's public dir). A safe path for the kit's `file` references. */
export const STAGED_MODELS_DIR = "models";

/**
 * Copies ONE catalogue model into <destDir> after the same checks every staged model gets: it must be a CC0 .glb of the manifest, a plain
 * file name, present, and equal to the manifest's size and sha256. Returns the file name. `done` makes a second call for the same file a no-op.
 */
export async function stageCatalogModel(id: string, catalog: Catalog3d, assetsDir: string, destDir: string, done: Set<string>): Promise<string> {
  const e = catalog.getById(id);
  if (!e || e.kind !== "model" || !(ALLOWED_LICENSES as readonly string[]).includes(e.license) || !e.file.endsWith(".glb") || e.file !== path.basename(e.file)) {
    throw new KnownFailure(`The scene uses the model "${id}", which is not a CC0 catalogue model. Run the earlier step again.`);
  }
  if (!done.has(e.file)) {
    const src = path.join(assetsDir, e.file);
    const st = await lstat(src).catch(() => null);
    if (!st?.isFile()) throw new KnownFailure(`The 3D model file ${e.file} is missing. Run \`npm run assets3d:fetch\` in the project folder, then run the render again.`);
    if ((await checkFile(assetsDir, e)) === "bad") throw new KnownFailure(`The 3D model file ${e.file} does not match the catalogue (wrong size or checksum). Run \`npm run assets3d:fetch\` again.`);
    await mkdir(destDir, { recursive: true, mode: 0o700 });
    await copyFile(src, path.join(destDir, e.file));
    done.add(e.file);
  }
  return e.file;
}

/**
 * Makes a scene renderable without the sandbox ever reading the repo: for every catalogue model the scene names, checks the file in
 * <assetsDir> against the manifest (size and sha256), copies ONLY that file into <inDir>/models/, and returns the scene with
 * that element's reference rewritten to the kit's `{file: "models/<file>"}` form (served from the in folder by staticFile).
 */
export async function stageSceneModels(scene: Scene3d, catalog: Catalog3d, assetsDir: string, inDir: string): Promise<Scene3d> {
  const dest = path.join(inDir, STAGED_MODELS_DIR);
  const done = new Set<string>();
  const elements: Scene3d["elements"] = [];
  for (const el of scene.elements) {
    if (el.kind !== "model") {
      elements.push(el);
      continue;
    }
    if (!("catalog" in el.model)) throw new KnownFailure(`The scene model "${el.id}" is not a catalogue model, so it cannot be rendered.`);
    const file = await stageCatalogModel(el.model.catalog, catalog, assetsDir, dest, done);
    elements.push({ ...el, model: { file: `${STAGED_MODELS_DIR}/${file}` } });
  }
  return { ...scene, elements };
}

/** The most frames a staged AI-written scene may have (75 s at 30 fps); render-entry.mjs checks the same limit. */
export const SCENE_CODE_MAX_FRAMES = 2250;

/**
 * Stages an AI-written scene into <inDir> and returns nothing: ONLY scene.tsx, props.json and the catalogue models the scene names
 * (each checked against the manifest). Before anything is written the host REFUSES (1) a source or props whose fingerprint differs from the one
 * approved, and (2) a source the static checker rejects (the same checker that accepted it at the author step: defence in depth). After
 * writing, scene.tsx is read back and compared again, so what the sandbox reads is byte for byte what was checked and approved.
 */
export type StagedTypeCheck = (source: string) => { ok: boolean; problems: string[]; sha256?: string; fatal?: boolean } | Promise<{ ok: boolean; problems: string[]; sha256?: string; fatal?: boolean }>;

export async function stageSceneCode(input: Scene3dCodeInput, catalog: Catalog3d, assetsDir: string, inDir: string, typeCheck: StagedTypeCheck): Promise<void> {
  if (sceneCodeSha(input.source, input.props) !== input.expectedSha256) {
    throw new KnownFailure("The scene is not the one you approved the look for. Run the preview pictures again and approve the new look. Nothing was rendered.");
  }
  const checked = checkScene3dCode(input.source);
  if (!checked.ok) throw new KnownFailure(`The scene code failed the safety check again, so it was not run: ${(checked.problems[0] ?? "unknown").slice(0, 160)} Nothing was rendered.`.slice(0, 600));
  const frames = Math.round(input.props.durationS * 30);
  if (!(frames >= 1 && frames <= SCENE_CODE_MAX_FRAMES)) throw new KnownFailure(`The scene is ${input.props.durationS} s long; the most is ${SCENE_CODE_MAX_FRAMES / 30} s. Nothing was rendered.`);
  const done = new Set<string>();
  const models: Record<string, string> = {};
  const dest = path.join(inDir, STAGED_MODELS_DIR);
  for (const id of sceneModelIds(input.source, (x) => catalog.getById(x)?.kind === "model")) {
    models[id] = `${STAGED_MODELS_DIR}/${await stageCatalogModel(id, catalog, assetsDir, dest, done)}`;
  }
  const file = path.join(inDir, "scene.tsx");
  await writeFile(file, input.source, { mode: 0o600, flag: "wx" });
  const back = await readFile(file, "utf8");
  if (sha256Hex(back) !== sha256Hex(input.source) || !checkScene3dCode(back).ok) throw new KnownFailure("The staged scene file changed after it was checked, so it was not run. Nothing was rendered.");
  // Layer 2 again, on the very bytes just staged. A failure, timeout or crash is fatal: nothing starts.
  const typed = await Promise.resolve().then(() => typeCheck(back)).catch(() => null);
  if (!typed || typed.fatal || !typed.ok || typed.sha256 !== sha256Hex(back)) {
    throw new KnownFailure(`The scene did not pass the type-check again (${(typed?.problems[0] ?? "the type-check crashed").slice(0, 120)}), so it was not run. Nothing was rendered.`.slice(0, 600));
  }
  const props = { beats: input.props.beats, captions: input.props.captions, durationS: input.props.durationS, frames, models };
  await writeFile(path.join(inDir, "props.json"), JSON.stringify(props), { mode: 0o600, flag: "wx" });
}
