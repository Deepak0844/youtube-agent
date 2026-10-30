// Scene-JSON reliability eval (Phase 4). OWNER-RUN, spends real money on a hosted model.
//
//   npm run eval:scenes -- --model <model id> [--runs 10] [--max-usd 0.5] [--yes]
//
// Without --yes it only prints the model, runs and cost ceiling, then exits (nothing is reserved or sent). With --yes it asks the
// model for scene JSON for each fixed beat sheet (retry twice with the errors fed back), every call reserved first against a
// per-run copy of the `eval` budget (max 2 USD), stops at the cap with a partial result, and writes .data/scene-reliability/.
import { mkdir, writeFile } from "node:fs/promises";
import { loadKeyring } from "@/server/db/master-key";
import { getPool } from "@/server/db/pool";
import { EvalRefusal } from "@/server/db/llm-eval";
import { planSceneEval, runSceneEval } from "@/server/db/scene-eval";
import { defaultModelDeps } from "@/server/llm/default-deps";
import { microToUsd } from "@/server/core/llm-catalog";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const modelId = arg("model");
  if (!modelId) throw new EvalRefusal("Give the model to test: --model <model id> (see the Models page). Nothing was sent.");
  const runs = arg("runs") === undefined ? undefined : Number(arg("runs"));
  const maxUsd = arg("max-usd") === undefined ? undefined : Number(arg("max-usd"));
  const yes = process.argv.includes("--yes");
  const db = getPool();
  try {
    const req = { modelId, ...(runs !== undefined ? { runs } : {}), ...(maxUsd !== undefined ? { maxUsd } : {}) };
    const plan = await planSceneEval(db, req);
    process.stdout.write(`Model: ${plan.model.label} (${plan.model.provider}/${plan.model.modelId})\nRuns: ${plan.sheets.length}\nCost ceiling: up to $${microToUsd(plan.ceilingMicroUsd)} (the run stops there)\n`);
    if (!yes) {
      process.stdout.write("Not run. Add --yes to spend up to that amount.\n");
      return;
    }
    const model = await defaultModelDeps(db, () => loadKeyring());
    const stop = new AbortController();
    process.once("SIGINT", () => {
      process.stderr.write("\nStopping after the call in flight. Ctrl-C again to quit now.\n");
      stop.abort();
      process.once("SIGINT", () => process.exit(130));
    });
    const out = await runSceneEval(db, req, { ...model, signal: stop.signal });
    for (const r of out.results) {
      process.stdout.write(`${r.id} ${r.kind}: first-try ${r.firstTry ? "pass" : "fail"}, within retries ${r.withinRetries ? "pass" : "fail"}, ${r.attempts} call(s), ${r.inputTokens}+${r.outputTokens} tokens, $${microToUsd(r.costMicroUsd)}${r.errors.length ? `, errors: ${r.errors.slice(0, 2).join(" | ")}` : ""}\n`);
    }
    const s = out.summary;
    const pct = (n: number) => (s.ran ? Math.round((n / s.ran) * 100) : 0);
    process.stdout.write(
      `\n${s.ran}/${s.planned} ran${out.stopped === "none" ? "" : ` (stopped early: ${out.stopped})`}. First try ${pct(s.firstTry)}%, within 2 retries ${pct(s.withinRetries)}%, cost $${microToUsd(s.costMicroUsd)}.\nVerdict: ${s.notRunReason !== undefined ? `NOT RUN (provider refused: ${s.notRunReason})` : s.verdict}\n` +
        (s.topErrors.length ? `Top repeated errors:\n${s.topErrors.map((e) => `  ${e.count}x ${e.message}`).join("\n")}\n` : ""),
    );
    if (s.notRunReason !== undefined) return;
    await mkdir(".data/scene-reliability", { recursive: true });
    const file = `.data/scene-reliability/${plan.model.modelId.replace(/[^a-z0-9._-]/gi, "_")}-${new Date().toISOString().slice(0, 10)}.json`;
    await writeFile(file, JSON.stringify(out, null, 2));
    process.stdout.write(`Saved ${file}\n`);
  } finally {
    await db.end().catch(() => {});
  }
}
main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof EvalRefusal ? err.message : `failed: ${err instanceof Error ? err.constructor.name : "unknown error"}`}\n`);
  process.exitCode = 1;
});
