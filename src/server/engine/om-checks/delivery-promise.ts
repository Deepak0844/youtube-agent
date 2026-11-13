// Port of OpenMontage lib/delivery_promise.py (AGPL-3.0, https://github.com/calesthio/OpenMontage) at the commit in
// engine-kit/openmontage/UPSTREAM.json: what a production promises to deliver (set at the proposal and locked), and whether a
// cut list keeps that promise. Same rules, ratios and wording. Proven equal on tests/fixtures/openmontage/goldens/promise-*.json.
import { pyGet, pyPercent } from "./py";

export type PromiseType = "motion_led" | "source_led" | "data_explainer" | "teacher_explainer" | "screen_demo" | "avatar_presenter" | "hybrid" | "localization";
export interface DeliveryPromise {
  promise_type: PromiseType;
  motion_required: boolean;
  source_required: boolean;
  tone_mode: string;
  quality_floor: string;
  approved_fallback: string | null;
}
export interface PromiseCheck {
  valid: boolean;
  violations: string[];
  motion_ratio: number;
  motion_cuts?: number;
  slide_cuts?: number;
  still_cuts?: number;
}

export const PROMISE_RULES: Record<PromiseType, { still_fallback_allowed: boolean; requires_video_generation: boolean; min_motion_ratio: number; description: string }> = {
  motion_led: { still_fallback_allowed: false, requires_video_generation: true, min_motion_ratio: 0.7, description: "Video's quality depends on real motion — generated video clips, footage, or animation." },
  source_led: { still_fallback_allowed: true, requires_video_generation: false, min_motion_ratio: 0.3, description: "User-provided footage is the primary medium. Generated assets fill gaps only." },
  data_explainer: { still_fallback_allowed: true, requires_video_generation: false, min_motion_ratio: 0.0, description: "Data visualization and explanation. Motion graphics preferred but images acceptable." },
  teacher_explainer: { still_fallback_allowed: true, requires_video_generation: false, min_motion_ratio: 0.0, description: "Educational content. Clarity and comprehension over spectacle." },
  screen_demo: { still_fallback_allowed: true, requires_video_generation: false, min_motion_ratio: 0.0, description: "Screen recording or product demo. Legibility over cinematic dressing." },
  avatar_presenter: { still_fallback_allowed: false, requires_video_generation: true, min_motion_ratio: 0.3, description: "AI avatar or talking head presentation. Requires video generation for presenter." },
  hybrid: { still_fallback_allowed: true, requires_video_generation: false, min_motion_ratio: 0.2, description: "Mix of source footage, generated content, and graphics." },
  localization: { still_fallback_allowed: true, requires_video_generation: false, min_motion_ratio: 0.0, description: "Translation/dubbing of existing video. Preserving source timing and clarity." },
};

const PIPELINE_DEFAULTS: Record<string, PromiseType> = {
  cinematic: "motion_led", "animated-explainer": "data_explainer", animation: "motion_led", "talking-head": "avatar_presenter",
  "avatar-spokesperson": "avatar_presenter", "screen-demo": "screen_demo", hybrid: "hybrid", "localization-dub": "localization",
  "podcast-repurpose": "source_led", "clip-factory": "source_led",
};
const SLIDE_TYPES = new Set(["text_card", "stat_card", "chart", "bar_chart", "line_chart", "pie_chart", "kpi_grid", "comparison", "progress", "callout"]);
const MOTION_TYPES = new Set(["video", "animation", "avatar"]);
const MOTION_EXT = new Set(["mp4", "mov", "webm", "avi", "mkv"]);

/** classify_from_brief(pipeline_type, user_intent): the default promise; the proposal director refines it. */
export function classifyFromBrief(pipelineType: string, userIntent: Record<string, unknown>): DeliveryPromise {
  let type: PromiseType = Object.hasOwn(PIPELINE_DEFAULTS, pipelineType) ? PIPELINE_DEFAULTS[pipelineType]! : "hybrid";
  if (userIntent.motion_required === false && type === "motion_led") type = "hybrid";
  const sourceRequired = pyGet(userIntent, "has_footage", false);
  if (sourceRequired && type !== "source_led" && type !== "localization") type = "source_led";
  const motionRequired = pyGet(userIntent, "motion_required", type === "motion_led" || type === "avatar_presenter");
  return {
    promise_type: type,
    motion_required: motionRequired as boolean,
    source_required: sourceRequired as boolean,
    tone_mode: pyGet(userIntent, "tone", "corporate") as string,
    quality_floor: pyGet(userIntent, "quality", "presentable") as string,
    approved_fallback: null,
  };
}

/** DeliveryPromise.validate_cuts: does this cut list keep the promise? Only real footage or animation counts as motion. */
export function validateCuts(promise: DeliveryPromise, cuts: Array<Record<string, unknown>>): PromiseCheck {
  const rules = PROMISE_RULES[promise.promise_type];
  if (cuts.length === 0) return { valid: false, violations: ["No cuts provided"], motion_ratio: 0.0 };
  let motion = 0;
  let slide = 0;
  let still = 0;
  for (const cut of cuts) {
    const source = String(pyGet(cut, "source", "") ?? "");
    const type = pyGet(cut, "type", "");
    let isMotion = false;
    let isSlide = false;
    if (source) {
      const ext = source.includes(".") ? source.slice(source.lastIndexOf(".") + 1).toLowerCase() : "";
      if (MOTION_EXT.has(ext)) isMotion = true;
    }
    if (MOTION_TYPES.has(type as string)) isMotion = true;
    else if (SLIDE_TYPES.has(type as string)) isSlide = true;
    if (isMotion) motion++;
    else if (isSlide) slide++;
    else still++;
  }
  const total = motion + slide + still;
  const ratio = total > 0 ? motion / total : 0.0;
  const violations: string[] = [];
  if (promise.motion_required && ratio < rules.min_motion_ratio) {
    violations.push(
      `Motion ratio ${pyPercent(ratio)} is below minimum ${pyPercent(rules.min_motion_ratio)} for ${promise.promise_type}. ` +
        `${motion}/${total} cuts have real motion (${slide} are animated slides which do not count as motion).`,
    );
  }
  const nonMotion = slide + still;
  if (!rules.still_fallback_allowed && nonMotion > total * 0.5 && promise.approved_fallback !== "still_led") {
    violations.push(
      `${promise.promise_type} does not allow still-led fallback, but ${nonMotion}/${total} cuts are non-motion (stills + animated slides). ` +
        "User must approve 'still_led' fallback or provide motion content.",
    );
  }
  return { valid: violations.length === 0, violations, motion_ratio: ratio, motion_cuts: motion, slide_cuts: slide, still_cuts: still };
}
