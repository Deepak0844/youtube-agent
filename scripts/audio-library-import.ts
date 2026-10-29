import path from "node:path";
import { getMigratePool } from "@/server/db/pool";
import { runChild } from "@/server/render/child";
import { importAudioLibrary } from "@/server/render/audio-import";

// Loads assets-builtin/audio into the audio library. Safe to run again: clips already present are left as they are.
async function main(): Promise<void> {
  const pool = getMigratePool();
  try {
    const r = await importAudioLibrary(pool, path.join(process.cwd(), "assets-builtin/audio"), { runChild });
    process.stdout.write(`audio library: ${r.added} added, ${r.existing} already there\n`);
  } catch (err) {
    process.stderr.write(`failed: ${err instanceof Error ? err.message : "unknown error"}\n`);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
}
void main();
