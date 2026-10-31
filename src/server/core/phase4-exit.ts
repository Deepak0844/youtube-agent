import { microToUsd } from "@/server/core/llm-catalog";

// Pure pieces of the owner-run Phase 4 exit helper (scripts/phase4-exit-check.ts). No IO, no spend.
// Phase 4 exit: topic -> script gate -> build -> render -> QA -> video gate reached on a cheap model.

export type Level = "OK" | "WARN" | "BLOCK";
export interface Line { level: Level; label: string; detail: string; fix?: string }

export const LANGUAGES = ["en", "hi", "ta", "te", "kn", "ml"] as const;
export type Language = (typeof LANGUAGES)[number];
const LANG_NAME: Record<Language, string> = { en: "English", hi: "Hindi", ta: "Tamil", te: "Telugu", kn: "Kannada", ml: "Malayalam" };
export const isLanguage = (x: string): x is Language => (LANGUAGES as readonly string[]).includes(x);

/** Malayalam has no word aligner, so its caption times are estimated. */
export const timingExpectation = (l: Language): string => (l === "ml" ? "estimated (read the captions against the audio before approving)" : "aligned (estimated only if the aligner is missing)");

export interface StageModelFact { stage: string; routed: boolean; enabled: boolean; priced: boolean; provider: string | null; label: string | null; keyPresent: boolean | null }
export interface Facts {
  db: { reachable: boolean; migrated: boolean };
  redisConfigured: boolean;
  voiceUrl: string; voiceListed: boolean; voiceReachable: boolean | null;
  models: StageModelFact[];
  docker: { daemon: boolean; image: boolean };
  ffmpeg: boolean; ffprobe: boolean;
  freeDiskGb: number | null;
  load1: number; cores: number;
  budgets: { dayCapMicro: number | null | undefined; dayRemainingMicro: number | null; draftRunCapMicro: number | null | undefined };
  searxUrl: string | null; searxReachable: boolean | null;
  voiceRoute: { provider: string; voice?: string } | null;
}

const ok = (label: string, detail: string): Line => ({ level: "OK", label, detail });
const warn = (label: string, detail: string, fix: string): Line => ({ level: "WARN", label, detail, fix });
const block = (label: string, detail: string, fix: string): Line => ({ level: "BLOCK", label, detail, fix });

export function evaluate(f: Facts): Line[] {
  const out: Line[] = [];
  out.push(!f.db.reachable ? block("Dev database", "not reachable", "Start the dev Postgres, then run npm run db:migrate.")
    : !f.db.migrated ? block("Dev database", "reachable, not fully migrated", "Run npm run db:migrate.") : ok("Dev database", "reachable and migrated"));
  out.push(f.redisConfigured ? ok("Worker queue", "REDIS_URL is set. Start the worker with npm run worker only for the run.") : block("Worker queue", "REDIS_URL is not set", "Set REDIS_URL in .env.local, then start Redis and npm run worker."));
  if (!f.voiceUrl) out.push(block("VoiceStudio address", "setting voice.voicestudio_url is empty", "Settings > Providers: set the VoiceStudio address (http://127.0.0.1:<port>)."));
  else {
    out.push(ok("VoiceStudio address", "set"));
    out.push(f.voiceListed ? ok("Local services list", "contains the VoiceStudio host:port") : block("Local services list", "network.local_services does not list the VoiceStudio host:port", "Settings > System: add the exact host:port to the local services list."));
    out.push(f.voiceReachable === true ? ok("VoiceStudio reachable", "GET /health answered")
      : f.voiceReachable === null ? warn("VoiceStudio reachable", "not tested (address not allowed yet)", "Fix the lines above, then run again.")
      : block("VoiceStudio reachable", "no answer from /health", "Start VoiceStudio on this machine."));
  }
  out.push(f.voiceRoute ? ok("Narration voice (default)", `${f.voiceRoute.provider}${f.voiceRoute.voice ? ` / ${f.voiceRoute.voice}` : ""}`) : block("Narration voice (default)", "no voice route chosen", "Settings > Providers: pick the default voice."));
  for (const m of f.models) {
    const name = `Model for ${m.stage}`;
    if (!m.routed) out.push(block(name, "no model is routed", "Settings > Models: route a cheap model (Gemini free key) to this stage."));
    else if (!m.enabled) out.push(block(name, `${m.label} is disabled`, "Settings > Models: enable it."));
    else if (!m.priced) out.push(block(name, `${m.label} has no price card`, "Settings > Models: add its prices (paid calls are refused without them)."));
    else if (m.keyPresent === false) out.push(block(name, `${m.label}: no ${m.provider} key in the vault`, "Settings > Providers: save the key."));
    else out.push(ok(name, `${m.label} (${m.provider}), enabled and priced${m.keyPresent ? ", key saved" : ""}`));
  }
  out.push(f.docker.daemon ? ok("Docker", "daemon reachable") : block("Docker", "daemon not reachable", "Open OrbStack/Docker only for the render step."));
  out.push(f.docker.image ? ok("Render image", "ytstudio-render:dev present") : block("Render image", "ytstudio-render:dev not found", "Run npm run image:render (once; heavy, close other apps first)."));
  out.push(f.ffmpeg ? ok("ffmpeg", "found") : block("ffmpeg", "not found", "Install ffmpeg (brew install ffmpeg)."));
  out.push(f.ffprobe ? ok("ffprobe", "found") : block("ffprobe", "not found", "Install ffmpeg (it ships ffprobe)."));
  out.push(f.freeDiskGb === null ? warn("Free disk", "unknown", "Check free space by hand.") : f.freeDiskGb < 2 ? block("Free disk", `${f.freeDiskGb.toFixed(1)} GB free`, "Free at least 2 GB.") : f.freeDiskGb < 10 ? warn("Free disk", `${f.freeDiskGb.toFixed(1)} GB free`, "Free some space (10 GB advised).") : ok("Free disk", `${f.freeDiskGb.toFixed(0)} GB free`));
  out.push(f.load1 > 4 ? warn("Machine load", `load average ${f.load1.toFixed(1)} on ${f.cores} cores`, "Close heavy apps (browsers, editors, Docker containers you do not need) before the run.") : ok("Machine load", `load average ${f.load1.toFixed(1)} on ${f.cores} cores`));
  const b = f.budgets;
  if (b.dayCapMicro === undefined || b.draftRunCapMicro === undefined) out.push(block("Budget caps", "day or draft-run cap row is missing", "Settings > Budgets: save the caps (defaults are fine)."));
  else if (b.dayCapMicro !== null && b.dayRemainingMicro !== null && b.dayRemainingMicro <= 0) out.push(block("Budget caps", "today's cap is used up", "Raise the day cap or wait for the next UTC day."));
  else out.push(ok("Budget caps", `day cap ${b.dayCapMicro === null ? "none" : `$${microToUsd(b.dayCapMicro)}`}${b.dayRemainingMicro === null ? "" : `, $${microToUsd(Math.max(0, b.dayRemainingMicro))} left today`}; draft-run cap ${b.draftRunCapMicro === null ? "none" : `$${microToUsd(b.draftRunCapMicro)}`}`));
  out.push(!f.searxUrl ? block("SearXNG", "SEARXNG_URL is not set (Draft searches the web)", "Set SEARXNG_URL in .env.local.")
    : f.searxReachable ? ok("SearXNG", "reachable") : block("SearXNG", "not reachable", "Start it only for this run, then stop it after."));
  for (const l of LANGUAGES) out.push(ok(`Language ${l}`, `${LANG_NAME[l]}: default voice above; word timing ${timingExpectation(l)}`));
  return out;
}

export const exitCode = (lines: readonly Line[]): 0 | 1 => (lines.some((l) => l.level === "BLOCK") ? 1 : 0);

export function formatChecklist(lines: readonly Line[]): string {
  const rows = lines.map((l) => `[${l.level.padEnd(5)}] ${l.label}: ${l.detail}${l.fix && l.level !== "OK" ? `\n        fix: ${l.fix}` : ""}`);
  const n = (lv: Level) => lines.filter((l) => l.level === lv).length;
  const verdict = n("BLOCK") ? `NOT READY: ${n("BLOCK")} blocker(s) to fix first.` : n("WARN") ? "READY, with warnings." : "READY.";
  return `${rows.join("\n")}\n\n${verdict}\n`;
}

// ---------- plan ----------
export interface PlanModel { stage: string; label: string; provider: string; inPerMTokMicro: number; outPerMTokMicro: number }
// ASSUMPTION: rough token use for one short video; a ceiling for planning, the real caps still apply.
const TOKENS: Record<string, { inTok: number; outTok: number }> = { draft: { inTok: 60_000, outTok: 12_000 }, build_scene_kit: { inTok: 30_000, outTok: 15_000 } };

export function nominalCostMicro(m: PlanModel): number {
  const t = TOKENS[m.stage] ?? { inTok: 0, outTok: 0 };
  return Math.round((t.inTok * m.inPerMTokMicro + t.outTok * m.outPerMTokMicro) / 1_000_000);
}

export function formatPlan(a: { lang: Language; steps: ReadonlyArray<{ stage: string; gateBefore?: string; gateAfter?: string }>; models: PlanModel[]; videoCapMicro: number }): string {
  const rows: string[] = [`Phase 4 exit run plan, one video, language ${a.lang} (${LANG_NAME[a.lang]}). The app starts nothing by itself.`, ""];
  let total = 0;
  for (const m of a.models) {
    const c = nominalCostMicro(m);
    total += c;
    rows.push(`Model ${m.stage}: ${m.label} (${m.provider}). Nominal ceiling $${microToUsd(c)}${m.provider === "gemini" ? " (Gemini free tier: real cost $0)" : ""}`);
  }
  const ceiling = Math.min(total, a.videoCapMicro);
  rows.push(`Cost ceiling for the run: $${microToUsd(ceiling)} nominal (per-video cap $${microToUsd(a.videoCapMicro)}); real spend on a free key: $0.`, "", "Steps:");
  a.steps.forEach((s, i) => rows.push(`  ${i + 1}. ${s.stage}${s.gateBefore ? `  (waits for your "${s.gateBefore}" approval first)` : ""}${s.gateAfter ? `  (then waits for your "${s.gateAfter}" approval)` : ""}`));
  rows.push(`Word timing for ${a.lang}: ${timingExpectation(a.lang)}.`, "", "What you run (in this order):",
    "  1. npm run check:phase4 -- --preflight    (fix every BLOCK)",
    "  2. start Redis, SearXNG, VoiceStudio, Docker; then: npm run dev:all",
    `  3. in the app open /videos/new, topic of your choice, language ${a.lang}, kind scene_kit, short`,
    "  4. approve the script gate when asked; wait for build, render, voice, sfx, QA",
    "  5. npm run check:phase4 -- --check <videoId>    (read-only report)",
    "  6. stop SearXNG, VoiceStudio and the worker afterwards", "");
  return rows.join("\n");
}

// ---------- exit verdict ----------
export interface StageFact { stage: string; status: string; durationMs: number | null }
export interface RunSummary {
  stages: StageFact[]; plannedStages: string[];
  scriptApproved: boolean; renderExists: boolean; qaBlocks: number; qaWarns: number;
  videoGateOpen: boolean; videoApproved: boolean; spendMicro: number; capMicro: number | null; timingKind: string | null;
}
export interface Verdict { pass: boolean; checks: Array<{ ok: boolean; text: string }>; missing: string[] }

export function exitVerdict(s: RunSummary): Verdict {
  const st = (n: string) => s.stages.find((x) => x.stage === n)?.status;
  const done = (n: string) => st(n) === "succeeded";
  const checks = [
    { ok: s.scriptApproved, text: "script gate approved" },
    { ok: done("build"), text: "build stage finished" },
    { ok: done("render") && s.renderExists, text: "render finished and render.mp4 exists" },
    { ok: done("qa"), text: "QA finished" },
    { ok: s.qaBlocks === 0, text: `QA has no blocking findings${s.qaBlocks ? ` (${s.qaBlocks} blocking)` : ""}` },
    { ok: s.videoGateOpen || s.videoApproved, text: "video gate reached" },
    { ok: s.capMicro === null || s.spendMicro <= s.capMicro, text: `spend $${microToUsd(s.spendMicro)} within the cap` },
  ];
  const failed = s.stages.filter((x) => x.status === "failed" || x.status === "needs_decision").map((x) => `stage ${x.stage} is ${x.status}`);
  return { pass: checks.every((c) => c.ok), checks, missing: [...checks.filter((c) => !c.ok).map((c) => c.text), ...failed] };
}

export function formatVerdict(v: Verdict): string {
  const rows = v.checks.map((c) => `[${c.ok ? "PASS" : "FAIL"}] ${c.text}`);
  return `${rows.join("\n")}\n\n${v.pass ? "PHASE 4 EXIT: PASS (topic -> script gate -> build -> render -> QA -> video gate reached)." : `PHASE 4 EXIT: NOT YET. Missing: ${v.missing.join("; ")}.`}\n`;
}
