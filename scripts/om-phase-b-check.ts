// OpenMontage parity, Phase B proof (dev only): checks the om/ artifacts an engine run wrote (npm run engine:smoke --
// --openmontage) against OpenMontage's schemas, then draws frames of its composition (om/composition.json) portrait through the
// locked renderer. Schema check uses Python's jsonschema (a general library, not OpenMontage code; this app's ajv is v6 and
// cannot read 2020-12 schemas). The composition is prepared as OpenMontage's video_compose does (composeOmProps: playbook theme,
// caption look). --video also renders the whole video (portrait) to <dir>/video.mp4.
//   npx tsx scripts/om-phase-b-check.ts [<dir>, default .data/compare/om-phase-b] [--video]
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildEngineConfig } from "@/server/core/engine-config";
import type { StageContext } from "@/server/core/stage-handler";
import { composeOmProps } from "@/server/engine/om-checks/compose";
import { omDurationFrames, renderOm } from "@/server/providers/renderer/om-render";
import type { TsxRendererDeps } from "@/server/providers/renderer/tsx-render";
import { probeVideo } from "@/server/render/probe";
import { runChild } from "@/server/render/child";
import { renderKitDir } from "@/worker/handlers";

const VALIDATE = `
import json, os, sys
from jsonschema import Draft202012Validator
om, schemas = sys.argv[1], sys.argv[2]
bad = 0
for f in sorted(os.listdir(om)):
    if not f.endswith(".json") or f.startswith("checkpoint_"): continue
    s = os.path.join(schemas, f.replace(".json", ".schema.json"))
    if not os.path.exists(s): print(f"{f}: no schema (not checked)"); continue
    errs = sorted(Draft202012Validator(json.load(open(s))).iter_errors(json.load(open(os.path.join(om, f)))), key=lambda e: list(e.path))
    bad += bool(errs)
    print(f"{f}: " + ("valid" if not errs else f"{len(errs)} problem(s): " + " | ".join(f"{'/'.join(map(str, e.path))}: {e.message[:120]}" for e in errs[:5])))
sys.exit(1 if bad else 0)
`;

async function main(): Promise<void> {
  const dir = path.resolve(process.argv.slice(2).find((a) => !a.startsWith("--")) ?? ".data/compare/om-phase-b");
  const wantVideo = process.argv.includes("--video");
  const om = path.join(dir, "om");
  console.log(`artifacts: ${readdirSync(om).join(", ")}`);
  let schemasOk = true;
  try {
    console.log(execFileSync("python3", ["-I", "-c", VALIDATE, om, path.resolve("engine-kit/openmontage/ref/schemas/artifacts")], { encoding: "utf8" }));
  } catch (e) {
    schemasOk = false;
    console.log((e as { stdout?: string }).stdout ?? e);
  }

  const composition = JSON.parse(readFileSync(path.join(om, "composition.json"), "utf8")) as Record<string, unknown>;
  const editDecisions = existsSync(path.join(om, "edit_decisions.json")) ? (JSON.parse(readFileSync(path.join(om, "edit_decisions.json"), "utf8")) as Record<string, unknown>) : null;
  const { props } = composeOmProps(composition, editDecisions);
  console.log(`theme: ${String(props.theme ?? props.playbook ?? "(none)")}; themeConfig ${props.themeConfig ? "added" : "not added"}`);
  const cuts = (props.cuts as Array<{ in_seconds: number; out_seconds: number }>) ?? [];
  const n = omDurationFrames(props);
  const frames = [...new Set(cuts.map((c) => Math.min(n - 1, Math.round(((c.in_seconds + c.out_seconds) / 2) * 30))))].slice(0, 8);
  const assetsDir = path.join(dir, "assets");
  const assets = existsSync(assetsDir) ? Object.fromEntries(readdirSync(assetsDir).map((f) => [f, path.join(assetsDir, f)])) : {};
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "om-phase-b-")));
  const deps: TsxRendererDeps = { kitDir: renderKitDir(), runChild: (spec) => runChild(spec), probe: (file, signal) => probeVideo(file, signal, { storageRoot: root }) };
  const ctx = { stage: { name: "om", videoId: "v" }, claim: { stageRunId: "om-phase-b", fence: 1, workerId: "c" }, config: buildEngineConfig(new Map()), signal: new AbortController().signal, attemptDir: root, log: () => undefined } as unknown as StageContext;
  try {
    const r = await renderOm(deps, ctx, { props, orientation: "portrait", outFile: "x.mp4", stills: frames, assets });
    if (!r.ok) throw new Error(`${r.message} ${r.problems.join(" | ")}`);
    for (const s of r.stills) copyFileSync(path.join(root, s), path.join(dir, s));
    console.log(`${r.stills.length} frames (${frames.join(", ")} of ${n}) -> ${dir}`);
    if (wantVideo) {
      const v = await renderOm(deps, ctx, { props, orientation: "portrait", outFile: "video.mp4", assets });
      if (!v.ok) throw new Error(`video: ${v.message} ${v.problems.join(" | ")}`);
      copyFileSync(v.outPath, path.join(dir, "video.mp4"));
      console.log(`video -> ${path.join(dir, "video.mp4")}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  if (!schemasOk) process.exitCode = 1;
}

void main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
