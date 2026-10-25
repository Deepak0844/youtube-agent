// Child process for the upload crash test. Run as `node --import tsx upload-process.ts`.
// env: DATABASE_URL, UPLOAD_ID. Starts the upload, reports progress, prints PROGRESS, then blocks forever
// (the test kills it with SIGKILL) -- the uploader never returns.
import { createPool } from "@/server/db/pool";
import { handleUploadJob } from "@/server/db/upload-job";

const keepAlive = setInterval(() => {}, 1 << 30);
const pool = createPool(process.env.DATABASE_URL!);
void handleUploadJob(
  pool,
  {
    startCtx: () => ({
      currentApprovalHash: "appr",
      currentFileSha: "sha",
      caps: { maxPerDay: 6, minSpacingMs: 0, dailyQuotaUnits: 100_000, costUnits: 1 },
    }),
    uploader: {
      async upload(_id, onProgress) {
        await onProgress(1234);
        process.stdout.write("PROGRESS\n");
        return new Promise(() => {});
      },
    },
  },
  process.env.UPLOAD_ID!,
).catch((e: unknown) => {
  process.stderr.write(`upload-process failed: ${String(e)}\n`);
  clearInterval(keepAlive);
  process.exit(1);
});
