import { KnownFailure } from "@/server/core/paid-call";
import { evaluateQa } from "@/server/core/qa";
import { probeVideo, ProbeError } from "@/server/render/probe";
import { promotedPath, type AttemptHandler } from "./attempt";
import { loadVideo, type StageDeps } from "./deps";

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
    let probed;
    try {
      probed = await (deps.probe ?? probeVideo)(file, ctx.signal, { storageRoot: deps.root, attemptDir: ctx.attemptDir });
    } catch (e) {
      if (e instanceof ProbeError) throw new KnownFailure(e.message);
      throw e;
    }
    const verdict = evaluateQa(probed, ctx.config.qa, { expectAudio: true, format: video.format });
    if (!verdict.pass) {
      const why = verdict.checks.filter((c) => !c.ok && c.level === "fail").map((c) => c.detail).join("; ");
      throw new KnownFailure(`qa_failed: ${why}`);
    }
    return {
      files: ["review-first.png", "review-last.png"],
      content: [{ kind: "video", file: "final.mp4" }],
      result: { checks: verdict.checks.map((c) => ({ id: c.id, ok: c.ok, level: c.level })), warnings: verdict.checks.filter((c) => !c.ok).map((c) => c.detail) },
    };
  };
}
