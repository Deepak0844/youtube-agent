import { copyFile, lstat, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { KnownFailure } from "@/server/core/paid-call";
import { loadCatalog, type Catalog3d } from "@/shared/assets3d/catalog";
import { ALLOWED_LICENSES } from "@/shared/assets3d/schema";
import { checkFile } from "@/shared/assets3d/files";
import type { Scene3d } from "@/shared/scene3d";

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
    const id = el.model.catalog;
    const e = catalog.getById(id);
    if (!e || e.kind !== "model" || !(ALLOWED_LICENSES as readonly string[]).includes(e.license) || !e.file.endsWith(".glb") || e.file !== path.basename(e.file)) {
      throw new KnownFailure(`The scene uses the model "${id}", which is not a CC0 catalogue model. Run the director step again.`);
    }
    if (!done.has(e.file)) {
      const src = path.join(assetsDir, e.file);
      const st = await lstat(src).catch(() => null);
      if (!st?.isFile()) throw new KnownFailure(`The 3D model file ${e.file} is missing. Run \`npm run assets3d:fetch\` in the project folder, then run the render again.`);
      if ((await checkFile(assetsDir, e)) === "bad") throw new KnownFailure(`The 3D model file ${e.file} does not match the catalogue (wrong size or checksum). Run \`npm run assets3d:fetch\` again.`);
      await mkdir(dest, { recursive: true, mode: 0o700 });
      await copyFile(src, path.join(dest, e.file));
      done.add(e.file);
    }
    elements.push({ ...el, model: { file: `${STAGED_MODELS_DIR}/${e.file}` } });
  }
  return { ...scene, elements };
}
