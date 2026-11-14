import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import type pg from "pg";
import { judgeDraft } from "@/server/authoring/draft/evidence-check";
import type { WebTools } from "@/server/authoring/draft/shared";
import { learningNotes } from "@/server/core/insights";
import { KnownFailure } from "@/server/core/paid-call";
import type { StageHandler } from "@/server/core/stage-handler";
import { loadInsightShorts } from "@/server/db/insights";
import { loadDraftVideo, pendingScriptFeedback, saveDraftContent } from "@/server/db/draft-store";
import { EngineLimitError } from "@/server/engine/limit";
import { researchTools } from "@/server/engine/mcp/research-tools";
import { runEngine } from "@/server/engine/run";
import { scriptRequest } from "@/server/engine/script-prompt";
import type { ChildRegistry } from "@/server/render/child";

// OpenMontage parity, Phase D3: the Draft step of a Short done by the engine (Claude Code on the owner's subscription, ADR 0015
// addendum). Claude researches with the app's own web tools and writes draft/script.json. THIS step then judges that file with the
// same contract and evidence checks as the paid draft, against the pages the tools really fetched, and saves it through the same
// fenced save, so the script gate and every later step are unchanged. No money is reserved or spent. A usage limit pauses the step
// (EngineLimitError); a script that fails the checks fails the step with the reason, and nothing is saved.

export interface EngineDraftDeps {
  db: pg.Pool;
  /** Where engine run folders live (defaultEngineRoot() in production). */
  root: string;
  makeWeb: () => WebTools;
  registry?: ChildRegistry;
  /** Test seam. */
  runEngine?: typeof runEngine;
}

const MAX_SCRIPT_BYTES = 64 * 1024;
const KINDS = ["tsx", "collage", "ai"] as const;

/** A JSON file the engine left in draft/: a plain file (no link on the way), at most `max` bytes; null when absent. */
async function readDraftJson(workDir: string, name: string, max: number, required: boolean): Promise<unknown> {
  const rel = path.join("draft", name);
  const bad = new KnownFailure(`The engine did not write ${rel.split(path.sep).join("/")}. Run the step again.`);
  for (let p = path.join(workDir, rel); p.startsWith(workDir + path.sep); p = path.dirname(p)) {
    if ((await lstat(p).catch(() => null))?.isSymbolicLink()) throw bad;
  }
  const st = await lstat(path.join(workDir, rel)).catch(() => null);
  if (!st?.isFile()) {
    if (required) throw bad;
    return null;
  }
  if (st.size > max) throw new KnownFailure(`The engine's ${rel.split(path.sep).join("/")} is over ${max / 1024} KB. Run the step again.`);
  try {
    return JSON.parse(await readFile(path.join(workDir, rel), "utf8"));
  } catch {
    if (!required) return null;
    throw new KnownFailure(`The engine's ${rel.split(path.sep).join("/")} is not valid JSON. Run the step again.`);
  }
}

/** The engine's optional type suggestion, shown at the script gate. Anything unusable is simply dropped. */
function suggestion(raw: unknown): { kind: (typeof KINDS)[number]; reason: string } | null {
  const s = raw as { kind?: unknown; reason?: unknown } | null;
  if (!s || typeof s.kind !== "string" || !(KINDS as readonly string[]).includes(s.kind) || typeof s.reason !== "string") return null;
  const reason = s.reason.replace(/\s+/g, " ").trim().slice(0, 160);
  return reason ? { kind: s.kind as (typeof KINDS)[number], reason } : null;
}

/** The Draft step is done by the engine only when it is switched on (Settings) and the video is a Short; everything else keeps the paid draft. */
export const usesEngineDraft = (config: { engine: { enabled: boolean } }, format: string): boolean => config.engine.enabled && format === "short";

export function engineDraftHandler(d: EngineDraftDeps): StageHandler {
  return async (ctx) => {
    const videoId = ctx.stage.videoId;
    if (!videoId) throw new KnownFailure("draft needs a video");
    const video = await loadDraftVideo(d.db, videoId);
    if (!video) throw new KnownFailure("The video for this draft no longer exists.");
    if (video.format !== "short") throw new KnownFailure("The engine writes the script of Shorts only; a long video is drafted by the paid model.");

    const feedback = await pendingScriptFeedback(d.db, videoId);
    const learning = learningNotes(await loadInsightShorts(d.db).catch(() => []));
    const { prompt } = scriptRequest({ topic: video.topic, lang: video.language, kind: video.kind, ...(video.notes ? { notes: video.notes } : {}), ...(feedback ? { feedback } : {}), ...(learning.length ? { learning } : {}) });

    const fetched = new Map<string, string>();
    const web = d.makeWeb();
    const judge = (raw: unknown, pages: ReadonlyMap<string, string>) => {
      const v = judgeDraft(raw, video.language, "short", pages, video.kind);
      return v.ok ? ({ ok: true } as const) : ({ ok: false, problems: v.problems } as const);
    };
    const r = await (d.runEngine ?? runEngine)(
      { db: d.db, root: d.root, config: ctx.config.engine, registry: d.registry, tools: (ws) => researchTools({ workDir: ws.workDir, web, fetched, judge }) },
      { videoId, stageRunId: ctx.claim.stageRunId, kind: "research", prompt, long: false, signal: ctx.signal, model: ctx.config.engine.model },
    );
    if (!r.ok) {
      if (r.limit) throw new EngineLimitError(r.resumeAt);
      throw new KnownFailure(r.message);
    }
    ctx.log(`engine: finished the script in ${r.turns} turns, ${fetched.size} pages read`);

    // Judged again here, against the pages the tools really fetched (the engine's own check_script ran on its side of the boundary).
    const raw = await readDraftJson(r.workDir, "script.json", MAX_SCRIPT_BYTES, true);
    const verdict = judgeDraft(raw, video.language, "short", fetched, video.kind);
    if (!verdict.ok) throw new KnownFailure(`The engine's script did not pass the checks: ${verdict.problems.slice(0, 3).join("; ").slice(0, 300)}. Run the step again.`);
    const hint = suggestion(await readDraftJson(r.workDir, "suggestion.json", 4 * 1024, false));

    const versions = await saveDraftContent(d.db, videoId, ctx.claim, verdict.script);
    return { title: verdict.script.title, spentMicroUsd: 0, versions, engine: { turns: r.turns, pages: fetched.size }, ...(hint ? { suggestedKind: hint.kind, suggestedReason: hint.reason } : {}) };
  };
}
