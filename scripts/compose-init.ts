import { spawnSync } from "node:child_process";
import { INIT_STEPS, refuseInit, stepOutcome } from "@/server/core/compose-setup";

// First run in compose: bootstrap the database roles, migrate, create the owner and print the one-time setup link. Safe to run
// again: bootstrap and migrate are idempotent, and an existing owner is a skip. Stops at the first real failure.
const refusal = refuseInit(process.env);
if (refusal) {
  process.stderr.write(`${refusal}\n`);
  process.exit(2);
}
for (const step of INIT_STEPS) {
  process.stdout.write(`== ${step}\n`);
  const r = spawnSync("npm", ["run", step], { stdio: ["ignore", "inherit", "pipe"], encoding: "utf8" }); // stdout inherited: owner:create prints the link there
  const outcome = stepOutcome(step, r.status ?? 1, r.stderr ?? "");
  if (outcome !== "skip") process.stderr.write(r.stderr ?? ""); // a skip's "already exists" text is not an error to show
  if (outcome === "fail") {
    process.stderr.write(`Setup stopped at ${step}.\n`);
    process.exit(1);
  }
  if (outcome === "skip") process.stdout.write(`(${step}: nothing to do, the owner already exists)\n`);
}
process.stdout.write(`Setup finished. Open ${process.env.APP_URL ?? "http://localhost:3000"}\n`);
