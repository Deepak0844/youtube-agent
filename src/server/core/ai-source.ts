import { STAGES, checkModelUsable, eligibleForStage, type ModelRow } from "@/server/core/llm-catalog";
import { SETTINGS } from "@/server/core/settings-registry";

// The "AI source for text stages" switch on Settings > Models (ADR 0014, step 2). Pure: no IO.
// ON points every stage Claude Code can do at the Claude Code catalog model and remembers the routes it replaced.
// OFF puts the remembered routes back, stage by stage. Stages Claude Code cannot do (tool calling, image input, web
// search) are never touched, and the notes say so in plain words.

/** stage -> model id, as stored in llm_routes (a stage with no route is absent). */
export type Routes = Readonly<Record<string, string>>;
/** stage -> the model id it had before the switch, or null when it had none. Stored in setting `ai.previous_routes`. */
export type Remembered = Record<string, string | null>;

export interface SwitchInput {
  on: boolean;
  routes: Routes;
  models: readonly ModelRow[];
  local: readonly string[];
  /** Current value of `ai.previous_routes`: null means the switch is off. */
  previous: Remembered | null;
  /** The Claude Code catalog model to route to (ON only). */
  claudeCodeId?: string;
}
export type SwitchPlan =
  | { ok: true; routes: Record<string, string | null>; previous: Remembered | null; notes: string[] }
  | { ok: false; reason: string };

/** The stored `ai.previous_routes`, checked with its registry schema. Anything that is not a valid set (a tampered or
 * hand-edited value) means "no previous routes", i.e. the switch is off: the page and the writer use this same reading. */
export function readRemembered(raw: unknown): Remembered | null {
  const r = SETTINGS["ai.previous_routes"].schema.safeParse(raw);
  return r.success ? r.data : null;
}

const label = (stage: string) => STAGES.find((s) => s.id === stage)?.label ?? stage;

export function planAiSource(input: SwitchInput): SwitchPlan {
  const byId = new Map(input.models.map((m) => [m.id, m]));
  const routes: Record<string, string | null> = Object.fromEntries(STAGES.map((s) => [s.id, input.routes[s.id] ?? null]));
  const notes: string[] = [];

  if (input.on) {
    if (input.previous !== null) return { ok: false, reason: "Claude Code is already the AI source for text stages." };
    // eligibleForStage judges a claude_code row as tool-free, whatever the row claims.
    const cc = input.claudeCodeId === undefined ? undefined : byId.get(input.claudeCodeId);
    if (!cc || cc.provider !== "claude_code") return { ok: false, reason: "There is no Claude Code model in the catalog." };
    if (!checkModelUsable(cc, input.local).ok) return { ok: false, reason: "The Claude Code model in the catalog is disabled. Enable it first." };
    const previous: Remembered = {};
    for (const s of STAGES) {
      const fit = eligibleForStage(s.id, cc);
      if (!fit.ok) {
        notes.push(`${s.label} stays on ${routes[s.id] ? "its current model" : "no model"}: it needs ${fit.missing.join(", ")}, and Claude Code runs with tools off here.`);
        continue;
      }
      previous[s.id] = routes[s.id] ?? null;
      routes[s.id] = cc.id;
      for (const w of fit.warnings) notes.push(`${s.label}: ${w}`);
    }
    return { ok: true, routes, previous, notes };
  }

  if (input.previous === null) return { ok: false, reason: "Claude Code is not the AI source right now." };
  for (const [stage, was] of Object.entries(input.previous)) {
    if (!Object.hasOwn(routes, stage)) continue; // a stage that no longer exists (or a name like "constructor")
    const now = routes[stage] ? byId.get(routes[stage]!) : undefined;
    if (now && now.provider !== "claude_code") {
      notes.push(`${label(stage)} keeps the model you chose after switching.`);
      continue;
    }
    if (was === null) {
      routes[stage] = null;
      continue;
    }
    const m = byId.get(was);
    if (!m) {
      routes[stage] = null;
      notes.push(`${label(stage)}: the model it used before was deleted, so it is now unset. Choose one below.`);
    } else if (!checkModelUsable(m, input.local).ok || !eligibleForStage(stage, m).ok) {
      routes[stage] = null;
      notes.push(`${label(stage)}: the model it used before (${m.label}) is disabled or can no longer do this stage, so it is now unset. Choose one below.`);
    } else {
      routes[stage] = was;
    }
  }
  // Claude Code is switched off with the switch, so no stage may be left on it (also one routed there by hand before ON).
  for (const s of STAGES) {
    const id = routes[s.id];
    if (id && byId.get(id)?.provider === "claude_code") {
      routes[s.id] = null;
      notes.push(`${s.label} was on Claude Code, which is now off, so it is unset. Choose a model below.`);
    }
  }
  return { ok: true, routes, previous: null, notes };
}

/** The switch form: source "claude_code" (needs the confirmation tick, exactly "on") or "api". Anything else is refused. */
export function parseAiSourceForm(form: FormData): { ok: true; on: boolean } | { ok: false; message: string } {
  const source = form.get("source");
  if (source === "api") return { ok: true, on: false };
  if (source !== "claude_code") return { ok: false, message: "Choose API keys or Claude Code." };
  if (form.get("confirm") !== "on") return { ok: false, message: "Tick the box to confirm that this starts a program on this Mac." };
  return { ok: true, on: true };
}

/** What Claude Code can do here (tools off): the page lists which stages stay on their API model and why. */
export function claudeCodeStageFit(): { label: string; ok: boolean; why: string }[] {
  const cc = { provider: "claude_code", capabilities: { structuredOutput: true, toolUse: false, vision: false, nativeWebSearch: false, contextWindow: 200000 }, endpointKind: "local" as const };
  return STAGES.map((s) => {
    const fit = eligibleForStage(s.id, cc);
    return { label: s.label, ok: fit.ok, why: fit.ok ? fit.warnings.join(" ") : `needs ${fit.missing.join(", ")}` };
  });
}
