// The webpack side of the import allow-list (layer 2 of the AI-written-scene controls; see render-entry.mjs). Kept in its own module so a
// BEHAVIOURAL unit test can bundle hostile scenes with exactly this configuration and assert the bundle FAILS.
// The scene file may import ONLY the modules below. It fails CLOSED:
//   - every module request made by ANY file under the job's in folder (not just scene.tsx) must be in the list;
//   - webpack's "context" features (require.context, import.meta.webpackContext, import(`./${x}`)) make a request whose issuer is the context
//     module, which a plain beforeResolve check misses: they are switched off in the parser for the scene file AND any context module
//     created for a file under the in folder is refused by a contextModuleFactory hook;
//   - issuers are compared after realpath, so a symlinked path cannot dodge the prefix.
import { realpathSync } from "node:fs";
import path from "node:path";

export const SCENE_IMPORTS = new Set(["react", "react/jsx-runtime", "react/jsx-dev-runtime", "remotion", "three", "@react-three/fiber", "s3k"]); // the jsx runtimes are what the compiler adds for <tags>

/** Parser switches for the scene file: no commonjs, no contexts, no workers, no new URL(), no amd; dynamic import() resolves like a static one. */
export const SCENE_PARSER = { commonjs: false, requireContext: false, importMetaContext: false, requireEnsure: false, requireInclude: false, requireJs: false, amd: false, worker: false, url: false, dynamicImportMode: "eager" };

const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/** Returns the webpack config for an authored-scene bundle: aliases (exact), module folders, parser rule and the fail-closed plugin. */
export function authorWebpack(c, { inDir, kitDir, repoRoot }) {
  const inReal = real(inDir);
  const sceneFile = path.join(inReal, "scene.tsx");
  const underIn = (issuer) => typeof issuer === "string" && issuer !== "" && (real(issuer) === sceneFile || real(issuer).startsWith(inReal + path.sep) || issuer.startsWith(inDir + path.sep));
  const plugin = {
    apply(compiler) {
      compiler.hooks.normalModuleFactory.tap("s3k-scene-allow-list", (nmf) => {
        nmf.hooks.beforeResolve.tap("s3k-scene-allow-list", (data) => {
          if (underIn(data.contextInfo?.issuer) && !SCENE_IMPORTS.has(data.request)) throw new Error(`the scene may not import "${String(data.request).slice(0, 60)}"`);
        });
      });
      compiler.hooks.contextModuleFactory.tap("s3k-scene-allow-list", (cmf) => {
        cmf.hooks.beforeResolve.tap("s3k-scene-allow-list", (data) => {
          const issuer = data?.contextInfo?.issuer;
          const ctxDir = typeof data?.context === "string" ? real(data.context) : "";
          if (underIn(issuer) || ctxDir === inReal || ctxDir.startsWith(inReal + path.sep)) throw new Error("the scene may not use dynamic or context imports");
        });
      });
    },
  };
  const a = c.resolve?.alias;
  const kit = path.join(kitDir, "s3k", "index.ts");
  const alias = Array.isArray(a) ? [...a, { name: "s3k-scene", alias: sceneFile, onlyModule: true }, { name: "s3k", alias: kit, onlyModule: true }] : { ...(a ?? {}), "s3k-scene$": sceneFile, "s3k$": kit };
  return {
    ...c,
    resolve: { ...c.resolve, modules: [...(c.resolve?.modules ?? ["node_modules"]), path.join(repoRoot, "node_modules")], alias },
    module: { ...c.module, rules: [...(c.module?.rules ?? []), { resource: sceneFile, parser: { javascript: SCENE_PARSER } }] },
    plugins: [...(c.plugins ?? []), plugin],
  };
}
