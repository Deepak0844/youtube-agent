import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import type { CaptionsBody } from "@/server/core/alignment";
import { getPool } from "@/server/db/pool";
import { latestContent } from "@/server/db/videos";
import { storageRoot } from "@/server/storage/paths";

// Listening sheet for the owner: for the latest local videos that have narration, the files to play and the captions to read.
// Reads this machine's database and storage folder only. No network, no provider call, no writes.
// usage: npm run check:phase3 [-- <how many videos, default 3>]
const peak = (file: string): string => {
  const out = spawnSync("ffmpeg", ["-nostdin", "-hide_banner", "-i", file, "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" }).stderr;
  return /max_volume:\s*(-?[\d.]+) dB/.exec(out)?.[1] ?? "unknown";
};

async function main(): Promise<void> {
  const pool = getPool();
  const root = storageRoot();
  try {
    const n = Math.min(20, Math.max(1, Number(process.argv[2] ?? 3) || 3));
    const { rows } = await pool.query<{ id: string; language: string; topic: string }>(
      "select v.id, v.language, v.topic from videos v where exists (select 1 from video_content c where c.video_id = v.id and c.kind = 'narration') order by v.created_at desc limit $1", [n]);
    if (rows.length === 0) process.stdout.write("No video with narration on this machine yet. Run a video through the voice step first.\n");
    for (const v of rows) {
      const narration = (await latestContent(pool, v.id, "narration"))?.body as { file?: string } | null;
      const captions = (await latestContent(pool, v.id, "captions"))?.body as CaptionsBody | null;
      process.stdout.write(`\n== ${v.language}  ${v.topic}  (${v.id})\n`);
      const files: Array<[string, string]> = [["narration", narration?.file ?? "narration.wav"], ["with narration on the picture", "voiced.mp4"], ["final mix", "final.mp4"]];
      for (const [label, name] of files) {
        const f = path.join(root, "videos", v.id, name);
        process.stdout.write(`  ${label}: ${existsSync(f) ? `${f}${name === "final.mp4" ? `   loudest point ${peak(f)} dBFS (must be -1.4 or lower)` : ""}` : "not made yet"}\n`);
      }
      if (!captions) { process.stdout.write("  captions: none\n"); continue; }
      const check = captions.needs_check || captions.approximate;
      process.stdout.write(`  captions: ${captions.timings_kind} times${check ? "  APPROXIMATE, read them against the audio and tick \"I checked the captions\" before approving" : ""}\n`);
      if (captions.flags.length) process.stdout.write(`  flags: ${captions.flags.join(", ")}\n`);
      process.stdout.write(`  first words: ${captions.words.slice(0, 10).map((w) => `${w.word} (${w.startS.toFixed(2)}s)`).join("  ")}\n`);
    }
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
