// Child process for the kill -9 tests. Run as `node --import tsx worker-process.ts` (ONE process: the tsx CLI
// would fork a second node process that a kill -9 of the parent leaves orphaned).
//
// env: DATABASE_URL, STAGE_ID, INPUT_HASH, WORKER_ID, TTL_MS (default 60000), STOP_AFTER (one marker below),
//      PROVIDER_DELAY_MS (pause inside the provider, after the call is recorded, before it returns).
// Prints one marker per line at exact points, then (at STOP_AFTER) blocks forever so the test can kill -9 it:
//   CLAIMED            stage claimed (fence bumped)
//   INTENT_RESERVED    reserve committed (intent pending); provider NOT called yet
//   PROVIDER_RETURNED  provider recorded the call and returned; settle NOT run yet
//   SETTLED            intent done; stage NOT committed
// With no STOP_AFTER it commits and prints COMMITTED, then exits.
import { createPgPaidCallPorts } from "@/server/db/paid-call-adapter";
import { createPool } from "@/server/db/pool";
import { claimStage, commitStage } from "@/server/db/stages";
import { runPaidCall, type PaidCallPorts } from "@/server/core/paid-call";
import { createFakeProvider } from "../../support/fake-provider";

type Marker = "CLAIMED" | "INTENT_RESERVED" | "PROVIDER_RETURNED" | "SETTLED";

const env = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
};

const stopAfter = process.env.STOP_AFTER as Marker | undefined;
const keepAlive = setInterval(() => {}, 1 << 30);
const forever = () => new Promise<never>(() => {});

async function mark(m: Marker): Promise<void> {
  process.stdout.write(`${m}\n`);
  if (stopAfter === m) await forever();
}

async function main(): Promise<void> {
  const pool = createPool(env("DATABASE_URL"));
  const claim = await claimStage(pool, {
    id: env("STAGE_ID"),
    inputHash: env("INPUT_HASH"),
    workerId: env("WORKER_ID"),
    ttlMs: Number(process.env.TTL_MS ?? 60_000),
  });
  if (!claim) throw new Error("claim failed");
  await mark("CLAIMED");

  const base = createPgPaidCallPorts(pool);
  const ports: PaidCallPorts = {
    ...base,
    reserve: async (c, args) => {
      const r = await base.reserve(c, args);
      if (r.kind === "new") await mark("INTENT_RESERVED");
      return r;
    },
    settle: async (intentId, args) => {
      await mark("PROVIDER_RETURNED");
      await base.settle(intentId, args);
      await mark("SETTLED");
    },
  };
  const provider = createFakeProvider({ pool });
  const delay = Number(process.env.PROVIDER_DELAY_MS ?? 0);
  const result = await runPaidCall(
    ports,
    { claim, stepIndex: 0, toolCallIndex: 0, reserveMicroUsd: 1000, budgetScopes: ["g"], kind: "paid" },
    async (key) => {
      const out = await provider.call(key);
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      return out;
    },
  );
  if (!(await commitStage(pool, claim, { steps: [result] }))) throw new Error("commit rejected");
  process.stdout.write("COMMITTED\n");
  clearInterval(keepAlive);
  await pool.end();
}

main().catch((err: unknown) => {
  process.stderr.write(`worker-process failed: ${String(err)}\n`);
  process.exit(1);
});
