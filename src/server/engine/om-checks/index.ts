// check_scenes: the checks OpenMontage runs before it renders an edit, in one report for the engine. As in OpenMontage, the
// composition (what the Explainer draws: om/composition.json) and the edit artifact (om/edit_decisions.json: renderer_family,
// delivery promise) are separate files; the validator and the cut checks read the composition. Ports (AGPL-3.0):
// tools/analysis/composition_validator.py (composition.ts) and video_compose.py _pre_compose_validation (below: delivery
// promise, slideshow risk, renderer_family), plus our own shape check of the scene list (checkOmProps, om-render.ts).
// Verdict: fail on any error or block (OpenMontage would not render), revise on a slideshow "revise" warning, else pass.
import { checkOmProps } from "@/server/providers/renderer/om-render";
import { validateComposition, type CompositionFiles } from "./composition";
import { promiseFromDict, validateCuts } from "./delivery-promise";
import { pyFixed, pyGet } from "./py";
import { scoreSlideshowRisk } from "./slideshow-risk";

type Obj = Record<string, unknown>;
export interface CheckScenesInput {
  /** om/composition.json: the Explainer props (cuts, overlays, captions, audio, theme) */
  composition: Obj;
  /** om/edit_decisions.json, when there is one (renderer_family, render_runtime, metadata.delivery_promise) */
  editDecisions?: Obj | null;
  /** om/scene_plan.json, when there is one */
  scenePlan?: Obj | null;
  /** om/proposal_packet.json, when there is one (its production_plan.delivery_promise is used if the edit has none) */
  proposal?: Obj | null;
  files: CompositionFiles;
}
export type Verdict = "pass" | "revise" | "fail";
const obj = (v: unknown): Obj => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {});
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(obj) : []);
const bullets = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`) : ["- none"]);

/** The asset names a composition refers to (cut sources and backgrounds, narration and music). */
export function referencedAssets(edit: Obj): string[] {
  const names = new Set<string>();
  for (const c of list(edit.cuts)) for (const k of ["source", "backgroundImage"]) if (typeof c[k] === "string" && c[k]) names.add(c[k] as string);
  for (const k of ["narration", "music"]) {
    const src = obj(obj(edit.audio)[k]).src;
    if (typeof src === "string" && src) names.add(src);
  }
  return [...names];
}

export function checkScenes(input: CheckScenesInput): { verdict: Verdict; report: string } {
  const compo = input.composition;
  const edit = obj(input.editDecisions);
  const cuts = list(compo.cuts);
  const blocks: string[] = [];
  const warnings: string[] = [];

  const shape = checkOmProps(compo);
  const comp = validateComposition(compo, input.files);

  // _pre_compose_validation 1: delivery promise (edit metadata, then the edit's top level, then our proposal packet)
  const promiseLines: string[] = [];
  const data = pyGet(obj(edit.metadata), "delivery_promise", null) || edit.delivery_promise || obj(compo.metadata).delivery_promise || obj(obj(input.proposal).production_plan).delivery_promise;
  if (data) {
    try {
      const promise = promiseFromDict(obj(data));
      const r = validateCuts(promise, cuts);
      promiseLines.push(`${promise.promise_type}: motion ratio ${pyFixed(r.motion_ratio * 100, 0)}% (${r.motion_cuts ?? 0} motion, ${r.slide_cuts ?? 0} animated slides, ${r.still_cuts ?? 0} stills)`);
      for (const v of r.violations) blocks.push(`Delivery promise violation: ${v}`);
    } catch (e) {
      warnings.push(`Could not validate delivery promise: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else warnings.push("No delivery_promise in edit_decisions — skipping promise validation");

  // _pre_compose_validation 2: slideshow risk (scene plan, or scenes made from the cuts)
  const rendererFamily = typeof edit.renderer_family === "string" && edit.renderer_family ? edit.renderer_family : null;
  let scenes = list(obj(input.scenePlan).scenes);
  if (scenes.length === 0 && cuts.length > 0) {
    scenes = cuts.map((c) => ({
      type: pyGet(c, "type", ""), description: pyGet(c, "reason", ""), shot_language: pyGet(c, "shot_language", {}), shot_intent: c.shot_intent ?? null,
      narrative_role: c.narrative_role ?? null, information_role: c.information_role ?? null, hero_moment: pyGet(c, "hero_moment", false),
    }));
  }
  const riskLines: string[] = [];
  if (scenes.length > 0) {
    const risk = scoreSlideshowRisk(scenes, edit, rendererFamily, typeof edit.render_runtime === "string" ? edit.render_runtime : null);
    riskLines.push(`average ${risk.average} (${risk.verdict})`, ...Object.entries(risk.dimensions).map(([k, d]) => `${k}: ${d.score} - ${d.reason}`));
    if (risk.verdict === "fail") blocks.push(`Slideshow risk score ${pyFixed(risk.average, 1)}/5.0 (verdict: fail). Video plan looks like a slideshow — revise scene plan before rendering.`);
    else if (risk.verdict === "revise") warnings.push(`Slideshow risk score ${pyFixed(risk.average, 1)}/5.0 (verdict: revise). Consider improving scene variety before final render.`);
  }

  // _pre_compose_validation 3: renderer_family must be set at the proposal
  if (!rendererFamily) {
    blocks.push("No renderer_family in edit_decisions. renderer_family must be set at proposal stage and locked before compose. Re-run the proposal stage with a renderer_family selection.");
  }

  const verdict: Verdict = shape.length || !comp.ok || blocks.length ? "fail" : warnings.some((w) => w.startsWith("Slideshow risk")) ? "revise" : "pass";
  const report = [
    "## Shape", ...bullets(shape),
    "", "## Assets and timing", ...bullets([...comp.errors, ...comp.warnings.map((w) => `warning: ${w}`), ...comp.info.map((i) => `info: ${i}`)]),
    "", "## Slideshow risk", ...bullets(riskLines.length ? riskLines : ["no scenes to score"]),
    "", "## Delivery promise", ...bullets(promiseLines.length ? promiseLines : ["not checked"]),
    "", "## Blocks (OpenMontage would not render)", ...bullets(blocks),
    "", "## Warnings", ...bullets(warnings),
    "", `VERDICT: ${verdict}`,
  ].join("\n");
  return { verdict, report };
}
