import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type pg from "pg";
import { mapCatalog, unlistedFiles, type CatalogEntry } from "@/server/core/audio-catalog";
import { addAudioItem } from "@/server/db/audio-library";
import type { ChildResult, ChildSpec } from "./child";

// Imports the shipped audio library (assets-builtin/audio). Order: read both catalogs, refuse the whole import if any
// file on disk is not listed, then measure each clip with ffmpeg/ffprobe through the child runner and add the rows.

export interface AudioImportDeps {
  runChild(spec: ChildSpec): Promise<ChildResult>;
}

async function lines(deps: AudioImportDeps, dir: string, command: string, args: string[]): Promise<string[]> {
  const out: string[] = [];
  const r = await deps.runChild({
    command, args, cwd: dir, cwdRoot: dir, timeoutMs: 120_000, maxOutputBytes: 1024 * 1024,
    signal: new AbortController().signal, onLine: (l) => out.push(l), stageRunId: "audio-library-import",
  });
  if (r.code !== 0 || r.truncated || r.timedOut) throw new Error(`${command} failed on an audio clip`);
  return out;
}

export async function measure(deps: AudioImportDeps, dir: string, file: string) {
  const dur = await lines(deps, dir, "ffprobe", ["-v", "error", "-protocol_whitelist", "file", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
  const log = await lines(deps, dir, "ffmpeg", ["-nostdin", "-hide_banner", "-protocol_whitelist", "file", "-i", file, "-af", "astats,loudnorm=print_format=json", "-f", "null", "-"]);
  const lufs = /"input_i"\s*:\s*"(-?[\d.]+|-inf)"/.exec(log.join("\n"));
  const peaks = log.filter((l) => /Peak level dB:/.test(l)); // per channel first, "Overall" last
  const peak = /Peak level dB:\s*(-?[\d.]+)/.exec(peaks.at(-1) ?? "");
  const durationS = Number(dur[0]);
  if (!lufs || !peak || !Number.isFinite(durationS)) throw new Error(`could not measure ${file}`);
  return { durationS, meanLufs: Number(lufs[1]), peakDbfs: Number(peak[1]) };
}

export async function importAudioLibrary(db: pg.Pool, root: string, deps: AudioImportDeps): Promise<{ added: number; existing: number }> {
  const plan: { entry: CatalogEntry; abs: string; rel: string }[] = [];
  for (const kind of ["sfx", "music"] as const) {
    const entries = mapCatalog(kind, JSON.parse(await readFile(path.join(root, kind, "catalog.json"), "utf8")));
    const onDisk = (await readdir(path.join(root, kind, "clips"))).map((f) => `clips/${f}`);
    const extra = unlistedFiles(onDisk, entries);
    if (extra.length) throw new Error(`${kind}: files not listed in catalog.json: ${extra.join(", ")}`);
    for (const entry of entries) plan.push({ entry, abs: path.join(root, kind, entry.file), rel: `${kind}/${entry.file}` });
  }
  let added = 0;
  let existing = 0;
  for (const { entry, abs, rel } of plan) {
    const sha256 = createHash("sha256").update(await readFile(abs)).digest("hex");
    const m = await measure(deps, root, abs);
    const before = await db.query("select 1 from audio_items where sha256 = $1", [sha256]);
    await addAudioItem(db, { kind: entry.kind, name: entry.name, tags: entry.tags, source: entry.source, licence: entry.licence, provenance: entry.provenance, filePath: rel, sha256, ...m });
    if (before.rowCount) existing++;
    else added++;
  }
  return { added, existing };
}
