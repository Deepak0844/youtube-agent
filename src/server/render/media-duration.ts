import path from "node:path";
import type { ChildResult, ChildSpec } from "./child";

// SECURITY CONTROL: the length of a media file in a run's assets/ folder, which Claude can write to. ffprobe runs through the
// child runner (registered, time- and output-capped, PATH only) with the file protocol only, and its demuxer is forced from
// the file's extension, so a playlist or concat list saved under a media name is never auto-detected and never opens other
// files. Any other extension is refused without running anything.

const DEMUXER: Record<string, string> = { ".wav": "wav", ".mp3": "mp3", ".m4a": "mov", ".aac": "mov", ".mp4": "mov", ".mov": "mov", ".flac": "flac", ".ogg": "ogg", ".webm": "webm" };

export interface MediaDurationDeps {
  runChild(spec: ChildSpec): Promise<ChildResult>;
  signal: AbortSignal;
  stageRunId: string;
}

/** Length in seconds, or null when the file cannot be read as its extension's format. */
export async function mediaDurationS(file: string, deps: MediaDurationDeps): Promise<number | null> {
  const fmt = DEMUXER[path.extname(file).toLowerCase()];
  if (!fmt || !path.isAbsolute(file)) return null;
  const lines: string[] = [];
  const r = await deps
    .runChild({
      command: "ffprobe",
      args: ["-v", "error", "-protocol_whitelist", "file", "-f", fmt, "-show_entries", "format=duration", "-of", "csv=p=0", file],
      cwd: path.dirname(file),
      timeoutMs: 20_000,
      maxOutputBytes: 64 * 1024,
      signal: deps.signal,
      stageRunId: deps.stageRunId,
      onLine: (l) => {
        lines.push(l);
      },
    })
    .catch(() => null);
  if (!r || r.code !== 0 || r.truncated || r.timedOut || r.aborted) return null;
  const d = Number(lines.find((l) => l.trim() !== "")?.trim());
  return Number.isFinite(d) && d > 0 ? d : null;
}
