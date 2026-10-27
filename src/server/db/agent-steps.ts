import { sanitizeToolCallId, sanitizeToolOutput, type AgentStepStore, type StoredToolOutput } from "@/server/core/agent-loop";
import type { Db } from "./stages";

const MAX_CALLS_PER_STEP = 256;
const clip = (s: string) => sanitizeToolCallId(s);

// Postgres side of the agent checkpoints (migration 0019). The store is bound to one stage run. A save succeeds only
// while the caller still holds the stage: status running, same fence, same owner (the rule every worker write follows).
// Outputs are sanitised again here (NUL, secret shapes, 16 KB) so the table is safe whoever calls it; sanitising is idempotent.
export function createPgAgentStepStore(db: Db, stageRunId: string): AgentStepStore {
  const read = async (stepIndex: number): Promise<Map<number, StoredToolOutput>> => {
    const { rows } = await db.query<{ call_index: number; tool_call_id: string; tool_name: string; args_hash: string; output: string }>(
      "select call_index, tool_call_id, tool_name, args_hash, output from agent_steps where stage_run_id = $1 and step_index = $2",
      [stageRunId, stepIndex],
    );
    return new Map(
      rows.map((r) => [r.call_index, { toolCallId: r.tool_call_id, toolName: r.tool_name, argsHash: r.args_hash, output: r.output }]),
    );
  };
  return {
    async loadOutputs(stepIndex) {
      const m = await read(stepIndex);
      return m.size ? m : null;
    },
    async saveOutputs(claim, stepIndex, outputs) {
      if (claim.stageRunId !== stageRunId) return null;
      const rows = outputs.filter((o) => Number.isInteger(o.index) && o.index >= 0 && o.index < MAX_CALLS_PER_STEP);
      let inserted = 0;
      if (rows.length > 0) {
        // `for share of s` holds the stage row's state while we write, so a reclaim cannot slip between check and insert.
        const r = await db.query(
          `insert into agent_steps (stage_run_id, step_index, call_index, tool_call_id, tool_name, args_hash, output, fence)
           select s.id, $4, t.idx, t.cid, t.tname, t.ahash, t.output, s.fence
             from stage_runs s,
                  unnest($5::int[], $6::text[], $7::text[], $8::text[], $9::text[]) as t(idx, cid, tname, ahash, output)
            where s.id = $1 and s.status = 'running' and s.fence = $2 and s.lease_owner = $3
              for share of s
           on conflict (stage_run_id, step_index, call_index) do nothing`,
          [
            stageRunId, claim.fence, claim.workerId, stepIndex,
            rows.map((o) => o.index),
            rows.map((o) => clip(o.toolCallId)),
            rows.map((o) => clip(o.toolName)),
            rows.map((o) => o.argsHash),
            rows.map((o) => sanitizeToolOutput(o.output)),
          ],
        );
        inserted = r.rowCount ?? 0;
      }
      if (inserted === 0) {
        // Nothing inserted: all rows existed already, or the claim is stale. Tell them apart with the gate itself.
        const { rows: gate } = await db.query(
          "select 1 from stage_runs where id = $1 and status = 'running' and fence = $2 and lease_owner = $3",
          [stageRunId, claim.fence, claim.workerId],
        );
        if (gate.length === 0) return null;
      }
      return read(stepIndex);
    },
  };
}

/** Retention: rows older than 7 days, through the owner-granted function (the app role cannot delete). */
export async function pruneAgentSteps(db: Db): Promise<number> {
  const { rows } = await db.query<{ n: string }>("select prune_agent_steps() as n");
  return Number(rows[0]!.n);
}
