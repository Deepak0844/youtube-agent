import { KnownFailure } from "@/server/core/paid-call";
import { evaluateQa } from "@/server/core/qa";
import { qaFindings, FINDING_DEFAULTS, type Finding } from "@/server/core/qa-findings";
import { probeVideo, ProbeError } from "@/server/render/probe";
import { STILLS } from "@/server/render/qa-scan";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { promotedPath, type AttemptHandler } from "./attempt";
import { contentBody, loadVideo, type StageDeps } from "./deps";

/**
 * QA: measures final.mp4 (Task 19 probe), judges it with the QA rules, and on a pass records it as the `video` content
 * version with the SHA-256 of its bytes (hashed while streaming). The owner's video gate hashes that version, so a changed
 * file voids the approval. Two review frames go to the attempt folder and are promoted. A fail is a known failure with the
 * plain reasons; nothing is saved and the owner sees why.
 */
export function qaAttempt(deps: StageDeps): AttemptHandler {
  return async (ctx) => {
    const video = await loadVideo(deps.db, ctx);
    const file = await promotedPath(deps.root, video.id, "final.mp4");
    const run = async <T,>(f: () => Promise<T>): Promise<T> => {
      try { return await f(); } catch (e) { if (e instanceof ProbeError) throw new KnownFailure(e.message); throw e; }
    };
    const probed = await run(() => (deps.probe ?? probeVideo)(file, ctx.signal, { storageRoot: deps.root, attemptDir: ctx.attemptDir }));
    const verdict = evaluateQa(probed, ctx.config.qa, { expectAudio: true, format: video.format });

    // Findings: the basic rules first (they own size/duration/audio ids), then the ffmpeg scan when wired. Block = qa_failed.
    const findings: Finding[] = verdict.checks.filter((c) => !c.ok).map((c) => ({ id: c.id, severity: c.level === "fail" ? "block" : "warn", text: c.detail }));
    const files: string[] = ["review-first.png", "review-last.png"];
    if (deps.qaScan) {
      const narration = await contentBody<{ file: string }>(deps.db, video.id, "narration").catch(() => null);
      const narrationFile = narration ? await promotedPath(deps.root, video.id, narration.file).catch(() => undefined) : undefined;
      const scan = await run(() => deps.qaScan!(file, ctx.signal, { storageRoot: deps.root, attemptDir: ctx.attemptDir, narrationFile }));
      const known = new Set(findings.map((f) => f.id));
      findings.push(...qaFindings(scan, { ...FINDING_DEFAULTS, stillMaxS: 2, width: ctx.config.qa[video.format].width, height: ctx.config.qa[video.format].height }).filter((f) => f.id !== "all_clear" && !known.has(f.id)));
      files.push(...STILLS);
    }
    if (findings.length === 0) findings.push({ id: "all_clear", severity: "info", text: "All automatic checks passed." });
    const blocks = findings.filter((f) => f.severity === "block");
    if (blocks.length > 0) throw new KnownFailure(`qa_failed: ${blocks.map((f) => f.text).join("; ")}`);
    await writeFile(path.join(ctx.attemptDir, "qa.json"), JSON.stringify({ findings }, null, 2));
    files.push("qa.json");
    return {
      files,
      content: [{ kind: "video", file: "final.mp4" }],
      result: { checks: verdict.checks.map((c) => ({ id: c.id, ok: c.ok, level: c.level })), warnings: findings.filter((f) => f.severity === "warn").map((f) => f.text), findings },
    };
  };
}
