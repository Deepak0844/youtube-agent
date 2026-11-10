import { readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildMixGraph } from "@/server/core/mix-graph";
import { bedAudibility, cueAudibility, type Verdict } from "@/server/core/sound-view";
import { KnownFailure } from "@/server/core/paid-call";
import { cutAudioArgs, type ClipWindow } from "@/server/core/derive-short";
import { cueSheet, SfxPlan } from "@/server/core/sfx-plan";
import type { StageContext } from "@/server/core/stage-handler";
import { audioFilePaths } from "@/server/db/audio-library";
import type pg from "pg";
import { safeJoin } from "@/server/storage/paths";
import type { ChildResult, ChildSpec } from "./child";

// Runs the sound pass: ffmpeg through the child runner (env allow-list, timeout, output cap, process group kill).
// The argument list itself comes from the pure core/mix-graph.ts.
export interface MixDeps {
  runChild(spec: ChildSpec): Promise<ChildResult>;
  /** Folder the audio library's file paths are relative to. */
  audioRoot: string;
}

async function run(mix: MixDeps, ctx: StageContext, command: "ffmpeg" | "ffprobe", args: string[], what = "The sound mix"): Promise<string[]> {
  const out: string[] = [];
  const r = await mix.runChild({
    command, args, cwd: ctx.attemptDir, cwdRoot: ctx.attemptDir, timeoutMs: 600_000, maxOutputBytes: 4 * 1024 * 1024,
    signal: ctx.signal, onLine: (l) => out.push(l), stageRunId: ctx.claim.stageRunId,
  });
  if (r.code !== 0 || r.truncated || r.timedOut || r.aborted) throw new KnownFailure(`${what} failed (${command} ${r.timedOut ? "timed out" : r.aborted ? "was stopped" : "returned an error"}).`);
  return out;
}

const IN = ["-protocol_whitelist", "file", "-i"];

/** Length of a media file in seconds, read with ffprobe (the file is not loaded into memory). */
export async function durationS(mix: MixDeps, ctx: StageContext, file: string): Promise<number> {
  const out = await run(mix, ctx, "ffprobe", ["-v", "error", "-protocol_whitelist", "file", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
  const d = Number(out[0]);
  if (!Number.isFinite(d) || d <= 0) throw new KnownFailure("Could not read the length of the video.");
  return d;
}

/** Mean level in dB of a file (or a window of it). Silence reads about -91. */
async function meanDb(mix: MixDeps, ctx: StageContext, file: string, window?: { from: number; len: number }): Promise<number> {
  const win = window ? ["-ss", String(window.from), "-t", String(window.len)] : [];
  const out = await run(mix, ctx, "ffmpeg", ["-nostdin", "-hide_banner", ...win, ...IN, file, "-vn", "-af", "volumedetect", "-f", "null", "-"]);
  const m = /mean_volume:\s*(-?[\d.]+|-inf)/.exec(out.join("\n"));
  return m ? (m[1] === "-inf" ? -91 : Number(m[1])) : -91;
}

/** Lays the narration on the render (no cues, no bed): loudness and limiter only. */
export async function muxNarration(mix: MixDeps, ctx: StageContext, qa: { meanDbMin: number; peakDbMax: number }, f: { video: string; voice: string; out: string }): Promise<void> {
  const { args } = buildMixGraph({ version: 1, cues: [] }, { videoS: await durationS(mix, ctx, f.video), voiceFile: f.voice, videoFile: f.video, outFile: f.out, items: {}, qa });
  await run(mix, ctx, "ffmpeg", args);
}

/** Mixes the sound plan onto the voiced video. Required inaudible cues fail with their ids; optional ones are dropped. Writes cue-sheet.txt beside the video. */
export async function mixPlan(mix: MixDeps, db: pg.Pool, ctx: StageContext, qa: { meanDbMin: number; peakDbMax: number }, f: { voiced: string; planFile: string; out: string }): Promise<{ droppedCues: string[]; usedItems: string[]; verdicts: Verdict[] }> {
  const raw = await readFile(f.planFile, "utf8").catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return '{"version":1,"cues":[]}';
    throw e;
  });
  let plan: SfxPlan;
  try {
    plan = SfxPlan.parse(JSON.parse(raw));
  } catch {
    throw new KnownFailure("The sound plan (sfx-plan.json) is not valid.");
  }
  const ids = [...new Set([...plan.cues.map((c) => c.itemId), ...(plan.bed ? [plan.bed.item] : [])])];
  const rel = await audioFilePaths(db, ids);
  const missing = ids.filter((i) => !rel.has(i));
  if (missing.length) throw new KnownFailure(`The sound plan names sounds that are not in the library: ${missing.join(", ")}.`);
  const items: Record<string, string> = {};
  for (const [id, p] of rel) {
    items[id] = await safeJoin(mix.audioRoot, p);
    await stat(items[id]).catch(() => { throw new KnownFailure(`A sound file in the library is missing (${p}).`); });
  }
  const videoS = await durationS(mix, ctx, f.voiced);

  const inaudible: string[] = [];
  const dropped: string[] = [];
  const verdicts: Verdict[] = [];
  const itemDb = new Map<string, number>();
  for (const c of plan.cues.filter((x) => x.atS < videoS)) {
    if (!itemDb.has(c.itemId)) itemDb.set(c.itemId, await meanDb(mix, ctx, items[c.itemId]!));
    const cueRmsDb = itemDb.get(c.itemId)! + c.gainDb;
    const voiceRmsDbAtCue = await meanDb(mix, ctx, f.voiced, { from: c.atS, len: 1 });
    const v = cueAudibility(c.id, cueRmsDb, voiceRmsDbAtCue);
    verdicts.push(v);
    if (v.audible) continue;
    (c.optional ? dropped : inaudible).push(c.id);
  }
  if (inaudible.length) throw new KnownFailure(`These sound cues would not be heard and are required: ${inaudible.join(", ")}. Change their level or timing, or mark them optional.`);
  plan = { ...plan, cues: plan.cues.filter((c) => !dropped.includes(c.id)) };
  // Shown on the Sound tab; never blocks the mix.
  if (plan.bed) verdicts.push(bedAudibility((await meanDb(mix, ctx, items[plan.bed.item]!)) + plan.bed.gainDb, await meanDb(mix, ctx, f.voiced)));

  const g = buildMixGraph(plan, { videoS, voiceFile: f.voiced, videoFile: f.voiced, outFile: f.out, items, qa });
  await run(mix, ctx, "ffmpeg", g.args);
  await writeFile(path.join(path.dirname(f.out), "cue-sheet.txt"), cueSheet(plan));
  const usedCues = new Set(plan.cues.filter((c) => !g.droppedCues.includes(c.id)).map((c) => c.itemId));
  return { droppedCues: [...dropped, ...g.droppedCues], usedItems: [...new Set([...usedCues, ...(plan.bed ? [plan.bed.item] : [])])], verdicts };
}

const CLIP_NAME = /^[A-Za-z0-9_-]{1,40}\.mp4$/;

/** The ffmpeg concat list: one `file 'name'` line per clip. Only plain names made here (no quotes, slashes or dots-only) are allowed. */
export function joinListText(clips: readonly string[]): string {
  if (clips.length < 1 || !clips.every((c) => CLIP_NAME.test(c))) throw new KnownFailure("The chapter clips have an unusable file name.");
  return clips.map((c) => `file '${c}'`).join("\n") + "\n";
}

/** Joins the clips without re-encoding (they all come from the same render settings, so the streams match). */
export function joinArgs(listFile: string, out: string): string[] {
  return ["-nostdin", "-hide_banner", "-y", "-f", "concat", "-safe", "1", "-protocol_whitelist", "file", "-i", listFile, "-c", "copy", "-movflags", "+faststart", out];
}

/**
 * Joins the chapter clips (plain file names in the attempt folder, in order) into `out`. Returns the length of the joined video in seconds.
 * Only the stage's own folder is touched; a failed ffmpeg is a plain failure that names no path.
 */
export async function joinClips(mix: MixDeps, ctx: StageContext, f: { clips: readonly string[]; out: string }): Promise<number> {
  const list = path.join(ctx.attemptDir, "chapters.txt");
  await writeFile(list, joinListText(f.clips), { mode: 0o600 });
  await run(mix, ctx, "ffmpeg", joinArgs(list, f.out), "Joining the chapters");
  return durationS(mix, ctx, f.out);
}

/**
 * Cuts the clip's narration out of the long video's narration (both plain files in the attempt folder or the video folder). Returns the length of the
 * cut in seconds; it must be within half a second of the window, else the cut is refused and removed.
 */
export async function cutNarration(mix: MixDeps, ctx: StageContext, f: { narration: string; out: string; window: Pick<ClipWindow, "startMs" | "durationMs"> }): Promise<number> {
  await run(mix, ctx, "ffmpeg", cutAudioArgs(f.narration, f.out, f.window), "Cutting the narration");
  const s = await durationS(mix, ctx, f.out);
  if (Math.abs(s - f.window.durationMs / 1000) > 0.5) {
    await rm(f.out, { force: true }).catch(() => undefined);
    throw new KnownFailure(`The cut narration is ${s.toFixed(1)} s but the clip is ${(f.window.durationMs / 1000).toFixed(1)} s. The narration file may be shorter than the video. Nothing was kept.`);
  }
  return s;
}
