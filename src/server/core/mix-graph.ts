import type { SfxPlan } from "./sfx-plan";

// Pure: builds the ffmpeg argument list for the sound pass (Doc 9 §5). Narration stays the main track; the bed and cues sit
// under it (sidechain ducking), then one loudness step and a hard limiter. The caller runs ffmpeg through the child runner.
export const LIMITER_CEILING_DB = -1.5;

export interface MixArgs {
  videoS: number;
  duckDb?: number;
  voiceFile: string;
  videoFile: string;
  outFile: string;
  /** item id -> absolute file path */
  items: Record<string, string>;
  qa: { meanDbMin: number; peakDbMax: number };
}

const lin = (db: number) => Math.pow(10, db / 20).toFixed(4);

export function buildMixGraph(plan: SfxPlan, a: MixArgs): { args: string[]; droppedCues: string[] } {
  const duck = a.duckDb ?? 9;
  const droppedCues: string[] = [];
  const kept = plan.cues.filter((c) => {
    const ok = c.atS < a.videoS && c.itemId in a.items;
    if (!ok) droppedCues.push(c.id);
    return ok;
  });
  const bed = plan.bed && plan.bed.item in a.items ? plan.bed : undefined;

  const inputs = [a.videoFile, a.voiceFile];
  const idx = (item: string) => {
    const file = a.items[item]!;
    let i = inputs.indexOf(file);
    if (i < 0) i = inputs.push(file) - 1;
    return i;
  };
  const chains: string[] = [];
  const bus: string[] = [];
  if (bed) {
    const loop = bed.loop ? "aloop=loop=-1:size=2000000000," : "";
    chains.push(`[${idx(bed.item)}:a]${loop}atrim=0:${a.videoS},volume=${bed.gainDb}dB[bed]`);
    bus.push("[bed]");
  }
  kept.forEach((c, n) => {
    const ms = Math.round(c.atS * 1000);
    chains.push(`[${idx(c.itemId)}:a]volume=${c.gainDb}dB,adelay=${ms}:all=1[c${n}]`);
    bus.push(`[c${n}]`);
  });

  // Loudness target: -16 LUFS, never below the QA mean floor. Peak target stays under both the limiter ceiling and the QA peak ceiling.
  const ceiling = Math.min(LIMITER_CEILING_DB, a.qa.peakDbMax);
  const finish = `loudnorm=I=${Math.max(-16, a.qa.meanDbMin)}:TP=${ceiling}:LRA=11,aresample=48000,alimiter=limit=${lin(ceiling)}:level=0`;
  if (bus.length === 0) {
    chains.push(`[1:a]${finish}[out]`);
  } else {
    chains.push(`[1:a]asplit=2[vo][vsc]`);
    chains.push(`${bus.join("")}amix=inputs=${bus.length}:normalize=0:duration=longest[sfx]`);
    chains.push(`[sfx][vsc]sidechaincompress=threshold=0.03:ratio=${Math.min(20, Math.max(1, duck))}:attack=20:release=300[ducked]`);
    chains.push(`[vo][ducked]amix=inputs=2:normalize=0:duration=longest,${finish}[out]`);
  }

  const args = ["-nostdin", "-hide_banner", "-y"];
  for (const f of inputs) args.push("-protocol_whitelist", "file", "-i", f);
  args.push("-filter_complex", chains.join(";"), "-map", "0:v", "-map", "[out]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-t", String(a.videoS), "-movflags", "+faststart", a.outFile);
  return { args, droppedCues };
}

const GAP_DB = -45; // voice quieter than this counts as a gap
const DENSE_DB = -20; // typical dense narration level

/**
 * Over speech a cue must sit at least 3 dB above its local floor (the voice level there); in a gap it must stay at least
 * 7 dB below dense narration. headroomDb is how far the cue is past that line (negative = fails).
 */
export function audibilityCheck(_cue: { id: string }, a: { cueRmsDb: number; voiceRmsDbAtCue: number }): { audible: boolean; headroomDb: number } {
  const headroomDb = a.voiceRmsDbAtCue > GAP_DB ? a.cueRmsDb - a.voiceRmsDbAtCue - 3 : DENSE_DB - 7 - a.cueRmsDb;
  return { audible: headroomDb >= 0, headroomDb };
}
