import { sanitizeToolOutput, type AgentStepStore } from "@/server/core/agent-loop";
import type { Db } from "./stages";

// Postgres side of the agent checkpoints (migration 0019). The store is bound to one stage run. A save succeeds only
// while the caller still holds the stage: status running, same fence, same owner (the rule every worker write follows).
// Outputs are sanitised again here (NUL, redaction, 16 KB) so the table is safe whoever calls it; sanitising is idempotent.
export function createPgAgentStepStore(db: Db, stageRunId: string): AgentStepStore {
  return {
    async loadOutputs(stepIndex) {
      const { rows } = await db.query<{ tool_call_id: string; output: string }>(
        "select tool_call_id, output from agent_steps where stage_run_id = $1 and step_index = $2",
        [stageRunId, stepIndex],
      );
      return rows.length ? new Map(rows.map((r) => [r.tool_call_id, r.output])) : null;
    },
    async saveOutputs(claim, stepIndex, outputs) {
      if (claim.stageRunId !== stageRunId) return false;
      if (outputs.length === 0) return true;
      const ids = outputs.map((o) => o.toolCallId);
      const texts = outputs.map((o) => sanitizeToolOutput(o.output));
      // Zero rows selected = stale claim (nothing inserted). A row that already exists is kept (do nothing) and still
      // counts as a successful save.
      const { rowCount } = await db.query(
        `insert into agent_steps (stage_run_id, step_index, tool_call_id, output, fence)
         select s.id, $4, t.id, t.output, s.fence
           from stage_runs s, unnest($5::text[], $6::text[]) as t(id, output)
          where s.id = $1 and s.status = 'running' and s.fence = $2 and s.lease_owner = $3
         on conflict (stage_run_id, step_index, tool_call_id) do nothing`,
        [stageRunId, claim.fence, claim.workerId, stepIndex, ids, texts],
      );
      if ((rowCount ?? 0) > 0) return true;
      // Nothing inserted: either all rows already existed, or the claim is stale. Tell them apart with the gate itself.
      const { rows } = await db.query(
        "select 1 from stage_runs where id = $1 and status = 'running' and fence = $2 and lease_owner = $3",
        [stageRunId, claim.fence, claim.workerId],
      );
      return rows.length > 0;
    },
  };
}
