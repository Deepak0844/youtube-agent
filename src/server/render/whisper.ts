import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { captionsBody, estimateTimings, flagLanguage, mapToScript, MAX_CHUNK_S, type CaptionsBody, type Recognised } from "@/server/core/alignment";
import type { Lang } from "@/server/core/lang";
import type { ChildResult, ChildSpec } from "./child";

// SECURITY CONTROL: whisper-cli runs only through the Phase 2 child runner (no shell, PATH-only environment so no key or
// DATABASE_URL reaches it, 120 s timeout, 5 MB output cap). The language, model path and audio path are forced by the code;
// no script text or other input becomes an argument. Output is written to a private temp folder that is removed afterwards.

export type ChildRunner = (spec: ChildSpec) => Promise<ChildResult>;
export class AlignError extends Error {}

const TIMEOUT_MS = 120_000;
const OUTPUT_CAP = 5 * 1024 * 1024;
const TEXT_TOKEN_MAX_ID = 50257; // ids from here up are special/timestamp tokens, not words

interface WhisperJson {
  transcription: { text: string; offsets: { from: number; to: number }; tokens: { p: number; id: number }[] }[];
}

export function parseWhisperJson(raw: string): Recognised[] {
  const j = JSON.parse(raw) as WhisperJson;
  return j.transcription
    .filter((s) => s.text.trim() !== "")
    .map((s) => ({
      word: s.text.trim(),
      startS: s.offsets.from / 1000,
      endS: s.offsets.to / 1000,
      p: Math.min(...s.tokens.filter((t) => t.id < TEXT_TOKEN_MAX_ID).map((t) => t.p), 1),
    }));
}

export interface AlignArgs { audioPath: string; durationS: number; lang: Lang; script: string[]; maxChunkS?: 15 }

/** Aligned captions for one chunk, or estimated ones when whisper recognised nothing usable. A failed child throws. */
export async function alignChunk(deps: { runChild: ChildRunner; modelPath: string }, a: AlignArgs): Promise<CaptionsBody> {
  if (a.durationS > MAX_CHUNK_S) throw new AlignError(`A chunk of ${a.durationS.toFixed(1)} s is too long to align (limit ${MAX_CHUNK_S} s); split it at a sentence first.`);
  const dir = await mkdtemp(path.join(tmpdir(), "align-"));
  try {
    const base = path.join(dir, "out");
    const r = await deps.runChild({
      command: "whisper-cli",
      args: ["-m", deps.modelPath, "-l", a.lang, "-f", a.audioPath, "-ml", "1", "-sow", "-ojf", "-of", base, "-np"],
      cwd: dir,
      cwdRoot: dir,
      envAllow: ["PATH"],
      timeoutMs: TIMEOUT_MS,
      maxOutputBytes: OUTPUT_CAP,
      signal: new AbortController().signal,
      stageRunId: "align",
    });
    if (r.timedOut || r.truncated || r.aborted || r.code !== 0) throw new AlignError("Word alignment failed; the audio was not aligned.");
    const mapped = mapToScript(a.script, parseWhisperJson(await readFile(base + ".json", "utf8")));
    if (mapped.stats.matched === 0) return captionsBody("estimated", estimateTimings(a.script, a.durationS));
    flagLanguage(a.lang, mapped.words);
    return captionsBody("aligned", mapped.words);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
