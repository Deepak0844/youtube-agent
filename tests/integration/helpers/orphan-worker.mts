// Helper process for the SIGKILL test: acts like a worker that runs a long child, then gets killed by the test.
import { createPool } from "@/server/db/pool";
import { runChild } from "@/server/render/child";
import { createChildRegistry } from "@/server/db/child-processes";

const url = process.env.HELPER_DATABASE_URL!;
const stageRunId = process.env.HELPER_STAGE_RUN_ID!;
const pool = createPool(url);
void runChild(
  {
    command: "sleep",
    args: ["300"],
    cwd: process.cwd(),
    timeoutMs: 600_000,
    maxOutputBytes: 1024,
    signal: new AbortController().signal,
    stageRunId,
  },
  { registry: createChildRegistry(pool, "helper-worker") },
);
setInterval(() => undefined, 1000);
