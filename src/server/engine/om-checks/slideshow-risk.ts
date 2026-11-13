// Port of OpenMontage lib/slideshow_risk.py (AGPL-3.0, https://github.com/calesthio/OpenMontage) at the commit in
// engine-kit/openmontage/UPSTREAM.json. Scores a scene plan on 6 dimensions (0-5, lower is better); same thresholds, rounding
// and wording. Proven equal on tests/fixtures/openmontage/goldens/slideshow-*.json.
import { mostCommon, pyGet, pyPercent, pyRound, pyTruthy } from "./py";

type Scene = Record<string, unknown>;
export interface Dimension {
  score: number;
  reason: string;
}
export interface SlideshowRisk {
  average: number;
  verdict: "strong" | "acceptable" | "revise" | "fail";
  dimensions: Record<string, Dimension>;
  render_runtime: string | null;
}

const NOT_MOVING = new Set<unknown>(["static", "unspecified", null]);
const shotLanguage = (s: Scene) => pyGet(s, "shot_language", {});
const movement = (s: Scene) => pyGet(shotLanguage(s), "camera_movement", "static");

function repetition(scenes: Scene[]): Dimension {
  if (scenes.length < 3) return { score: 0.0, reason: "Too few scenes to assess repetition" };
  const [topType, topCount] = mostCommon(scenes.map((s) => pyGet(s, "type", "unknown")));
  const typeRatio = topCount / scenes.length;
  const descriptions = scenes.map((s) => String(pyGet(s, "description", "")).toLowerCase().slice(0, 50));
  const uniqueRatio = new Set(descriptions).size / descriptions.length;
  const sizeRatio = mostCommon(scenes.map((s) => pyGet(shotLanguage(s), "shot_size", "none")))[1] / scenes.length;
  let score = 0.0;
  const reasons: string[] = [];
  if (typeRatio > 0.7) {
    score += 2.0;
    reasons.push(`Scene type '${String(topType)}' dominates at ${pyPercent(typeRatio)}`);
  }
  if (uniqueRatio < 0.6) {
    score += 1.5;
    reasons.push(`Only ${pyPercent(uniqueRatio)} unique descriptions`);
  }
  if (sizeRatio > 0.6) {
    score += 1.5;
    reasons.push(`Same shot size in ${pyPercent(sizeRatio)} of scenes`);
  }
  return { score: Math.min(5.0, score), reason: reasons.join("; ") || "Good variety" };
}

function decorative(scenes: Scene[]): Dimension {
  const count = scenes.filter((s) => !pyTruthy(s.information_role) && !pyTruthy(s.narrative_role) && !pyTruthy(s.shot_intent)).length;
  const ratio = count / scenes.length;
  const reason =
    ratio > 0.5 ? `${count}/${scenes.length} scenes have no stated purpose (no information_role, narrative_role, or shot_intent)`
    : ratio > 0.2 ? `${count}/${scenes.length} scenes lack stated purpose`
    : "Most scenes have clear communicative purpose";
  return { score: pyRound(Math.min(5.0, ratio * 5.0), 1), reason };
}

function weakMotion(scenes: Scene[]): Dimension {
  const moving = scenes.filter((s) => !NOT_MOVING.has(movement(s)));
  if (moving.length === 0) return { score: 1.5, reason: "No camera movement defined (may be intentional for static style)" };
  const purposeless = moving.filter((s) => !pyTruthy(s.shot_intent)).length;
  const ratio = purposeless / moving.length;
  return { score: pyRound(Math.min(5.0, ratio * 4.0), 1), reason: ratio > 0.5 ? `${purposeless}/${moving.length} moving shots lack shot_intent` : "Camera movement appears purposeful" };
}

function weakIntent(scenes: Scene[]): Dimension {
  const withIntent = scenes.filter((s) => pyTruthy(s.shot_intent)).length;
  const ratio = withIntent / scenes.length;
  const reason =
    ratio < 0.3 ? `Only ${withIntent}/${scenes.length} scenes have shot_intent — most shots lack purpose`
    : ratio < 0.6 ? `${withIntent}/${scenes.length} scenes have shot_intent`
    : "Strong shot intent coverage";
  return { score: pyRound(Math.min(5.0, (1.0 - ratio) * 5.0), 1), reason };
}

function typography(scenes: Scene[]): Dimension {
  const text = scenes.filter((s) => ["text_card", "stat_card", "kpi_grid"].includes(s.type as string)).length;
  const ratio = text / scenes.length;
  if (ratio > 0.6) return { score: 4.0, reason: `${text}/${scenes.length} scenes are text/stat cards — video feels like animated slides` };
  if (ratio > 0.4) return { score: 2.5, reason: `${text}/${scenes.length} scenes are text-based — consider balancing with visual scenes` };
  if (ratio > 0.2) return { score: 1.0, reason: "Balanced text and visual content" };
  return { score: 0.0, reason: "Visual-first approach" };
}

function cinematicClaims(scenes: Scene[], family: string | null | undefined): Dimension {
  if (!(family && family.toLowerCase().includes("cinematic"))) return { score: 0.0, reason: "Not claiming cinematic treatment" };
  const issues: string[] = [];
  if (scenes.filter((s) => pyTruthy(s.hero_moment)).length === 0) issues.push("Claims cinematic but has no hero_moment defined");
  const moving = scenes.filter((s) => !NOT_MOVING.has(movement(s))).length;
  if (moving < scenes.length * 0.3) issues.push(`Claims cinematic but only ${moving}/${scenes.length} scenes have camera movement`);
  const lit = scenes.filter((s) => pyTruthy(pyGet(shotLanguage(s), "lighting_key", undefined))).length;
  if (lit < scenes.length * 0.3) issues.push(`Claims cinematic but only ${lit}/${scenes.length} scenes define lighting`);
  return { score: pyRound(Math.min(5.0, issues.length * 1.8), 1), reason: issues.length ? issues.join("; ") : "Cinematic claims supported by structure" };
}

export function scoreSlideshowRisk(scenes: Scene[], _editDecisions?: Record<string, unknown> | null, rendererFamily?: string | null, renderRuntime: string | null = null): SlideshowRisk {
  if (scenes.length === 0) return { average: 5.0, verdict: "fail", dimensions: {}, render_runtime: renderRuntime };
  const dimensions: Record<string, Dimension> = {
    repetition: repetition(scenes),
    decorative_visuals: decorative(scenes),
    weak_motion: weakMotion(scenes),
    weak_shot_intent: weakIntent(scenes),
    typography_overreliance: typography(scenes),
    unsupported_cinematic_claims: cinematicClaims(scenes, rendererFamily),
  };
  const scores = Object.values(dimensions).map((d) => d.score);
  const average = scores.reduce((a, b) => a + b, 0) / scores.length;
  const verdict = average < 2.0 ? "strong" : average < 3.0 ? "acceptable" : average < 4.0 ? "revise" : "fail";
  return { average: pyRound(average, 2), verdict, dimensions, render_runtime: renderRuntime };
}
