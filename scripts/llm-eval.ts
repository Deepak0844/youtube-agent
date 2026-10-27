// Per-model Draft eval (Phase 2 Task 18). OWNER-RUN, spends real money on a hosted model.
//
//   npm run eval:llm -- --model <catalog id> [--mode agent|search_then_write] [--topics 10] [--max-usd 2] [--yes]
//
// Without --yes it only prints the cost ceiling and exits (nothing is reserved or sent). With --yes it runs the 10 fixed
// topics through Draft on the model, every call reserved first against a per-run copy of the `eval` budget (capped at
// --max-usd or the seeded cap, whichever is lower), stops at the cap with a partial result, and sets the model's draft mode.
import { loadKeyring } from "@/server/db/master-key";
import { getPool } from "@/server/db/pool";
import { EvalRefusal, planEval, runEval } from "@/server/db/llm-eval";
import { defaultModelDeps } from "@/server/llm/default-deps";
import { createWebTools } from "@/server/llm/web-tools";
import { microToUsd } from "@/server/core/llm-catalog";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const modelId = arg("model");
  if (!modelId) throw new EvalRefusal("Give the model to test: --model <catalog id> (see the Models page). Nothing was sent.");
  const mode = arg("mode") ?? "search_then_write";
  if (mode !== "agent" && mode !== "search_then_write") throw new EvalRefusal("--mode must be agent or search_then_write.");
  const topics = arg("topics") === undefined ? undefined : Number(arg("topics"));
  const maxUsd = arg("max-usd") === undefined ? undefined : Number(arg("max-usd"));
  const yes = process.argv.includes("--yes");
  const searxUrl = process.env.SEARXNG_URL;
  if (!searxUrl) throw new EvalRefusal("Web search is not set up (SEARXNG_URL).");

  const db = getPool();
  try {
    const req = { modelId, mode, ...(topics !== undefined ? { topics } : {}), ...(maxUsd !== undefined ? { maxUsd } : {}), actor: { kind: "owner_cli" } } as const;
    const plan = await planEval(db, req, {});
    process.stdout.write(
      `Model: ${plan.model.label} (${plan.model.provider}/${plan.model.modelId})\nMode: ${plan.mode}\nTopics: ${plan.topics.length}\nCost ceiling: up to $${microToUsd(plan.ceilingMicroUsd)} (the run stops there)\n`,
    );
    if (!yes) {
      process.stdout.write("Not run. Add --yes to spend up to that amount.\n");
      return;
    }
    const model = await defaultModelDeps(db, () => loadKeyring());
    const out = await runEval(db, { ...req, confirmed: true }, { ...model, makeWeb: () => createWebTools({ searxUrl }) });
    process.stdout.write(
      `Done${out.stopped === "none" ? "" : ` (stopped early: ${out.stopped})`}. ${out.topics}/${out.planned} topics, ${out.valid} valid script, ${out.evidenceValid} valid evidence, cost $${microToUsd(out.costMicroUsd)}, median ${out.p50LatencyMs} ms.\n` +
        `${out.note ? `${out.note}\n` : ""}Draft mode for this model: ${out.draftMode}${out.draftModeChanged ? " (changed)" : ""}.\n`,
    );
  } finally {
    await db.end().catch(() => {});
  }
}
main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof EvalRefusal ? err.message : `failed: ${err instanceof Error ? err.constructor.name : "unknown error"}`}\n`);
  process.exitCode = 1;
});
