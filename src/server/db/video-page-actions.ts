import type pg from "pg";
import { actorProblem, ACTOR_REASON, type GateActor } from "@/server/core/approvals";
import { STAGE_NAMES, type StageName } from "@/server/core/pipeline-plan";
import { approvalReaders } from "@/server/db/approval-readers";
import { recordAudit } from "@/server/db/audit";
import { rerunStage, type EnqueueOnly } from "@/server/db/pipeline";
import type { ActionResult } from "@/server/db/queue-actions";

// The DB part of the video page's "Run again" button. The caller (actions.ts) has done requireOwner and the Origin check.
// The pipeline's own rerunStage owns every rule (a live video, the step failed or cancelled, the earlier step done);
// its refusals are shown as plain sentences.

const refuse = (message: string): ActionResult => ({ ok: false, message });
const REFUSALS: Record<string, string> = {
  cannot_rerun_while_job_active: "This step is already running or waiting to run.",
  "nothing changed since this stage last succeeded": "Nothing changed since this step last finished, so there is nothing to run again.",
  "run the earlier stage first": "An earlier step has not finished yet. Run that one first.",
};

export async function rerunStageById(db: pg.Pool, queue: EnqueueOnly, actor: GateActor, videoId: string, stage: string): Promise<ActionResult> {
  if (actorProblem(actor)) return refuse(ACTOR_REASON);
  if (!(STAGE_NAMES as readonly string[]).includes(stage)) return refuse("That step is not part of this video.");
  let r;
  try {
    r = await rerunStage(db, queue, videoId, stage as StageName, approvalReaders);
  } catch (e) {
    const m = e instanceof Error ? e.message : "";
    if (/^video is /.test(m)) return refuse("This video is no longer in production.");
    return refuse(REFUSALS[m] ?? "That step could not be run again.");
  }
  await recordAudit(db, "stage.rerun_requested", { videoId, stage, sessionId: actor.sessionId });
  if (r.held) return { ok: true, message: "This step is paused after repeated failures, so it will start when the pause ends." };
  return { ok: true, message: "Queued. The step will run again." };
}
