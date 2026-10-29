import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { KnownFailure } from "@/server/core/paid-call";
import type { StageContext } from "@/server/core/stage-handler";
import { addAudioItem, findLibraryFirst, type AudioItem, type AudioKind } from "@/server/db/audio-library";
import type { Db } from "@/server/db/stages";
import { measure } from "@/server/render/audio-import";
import type { ChildResult, ChildSpec } from "@/server/render/child";
import type { MediaArtifact } from "../media-types";

export interface SoundProvider {
  quoteSfx(a: { prompt: string; seconds: number }): number;
  makeSfx(ctx: StageContext, a: { prompt: string; seconds: number }): Promise<MediaArtifact>;
  quoteMusic(a: { prompt: string; seconds: number }): number;
  makeMusic(ctx: StageContext, a: { prompt: string; seconds: number }): Promise<MediaArtifact>;
}

export interface SoundDeps {
  db: Db;
  provider: SoundProvider;
  runChild(spec: ChildSpec): Promise<ChildResult>;
  /** Folder the library's file paths are relative to (same as the mixer's audioRoot). */
  audioRoot: string;
  /** True only when the cost plan or an explicit owner "generate" choice allows paying for a new clip. */
  generateAllowed: boolean;
}

export interface SoundNeed { kind: AudioKind; prompt: string; tags: string[]; seconds: number }

export const MAX_PROMPT = 500;
/** Plain text: control characters removed and trimmed; null when empty or over 500 code points. */
export function cleanPrompt(raw: string): string | null {
  const t = raw.replace(/\p{Cc}/gu, "").trim();
  return t === "" || Array.from(t).length > MAX_PROMPT ? null : t;
}

const TARGET_LUFS = -20;
const CEILING_DBFS = -1.5;

/** Library first; generate only when allowed. A failed generation is thrown as is: never swapped for a library track. */
export async function ensureSound(ctx: StageContext, deps: SoundDeps, need: SoundNeed): Promise<AudioItem> {
  // findLibraryFirst matches on shared tags only, so an empty list would always miss and then pay.
  if (need.tags.length === 0) throw new KnownFailure("A sound needs at least one tag so the library can be searched.");
  const prompt = cleanPrompt(need.prompt);
  if (prompt === null) throw new KnownFailure(`A sound needs a description of 1 to ${MAX_PROMPT} characters.`);
  // An effect must not be longer than asked; a music bed must be at least half the asked length (the mixer trims longer ones).
  const hits = await findLibraryFirst(deps.db, { kind: need.kind, tags: need.tags, maxDurationS: need.kind === "sfx" ? need.seconds : undefined });
  const hit = hits.find((h) => need.kind === "sfx" || (h.durationS ?? 0) >= need.seconds * 0.5);
  if (hit) return hit;
  if (!deps.generateAllowed) throw new KnownFailure("No sound in the library matches, and generating a new one is not allowed. Choose \"generate\", or pick a library track yourself.");

  const a = { prompt, seconds: need.seconds };
  const art = need.kind === "sfx" ? await deps.provider.makeSfx(ctx, a) : await deps.provider.makeMusic(ctx, a);

  // Keep the paid clip outside the attempt folder (a retry gets a new one) and level from that copy.
  const rawRel = `generated/raw-${art.sha256.slice(0, 16)}.mp3`;
  const raw = path.join(deps.audioRoot, rawRel);
  await mkdir(path.join(deps.audioRoot, "generated"), { recursive: true });
  if (!(await stat(raw).then(() => true, () => false))) await copyFile(art.path, raw);

  const norm = path.join(ctx.attemptDir, `norm-${art.sha256.slice(0, 12)}.mp3`);
  const out: string[] = [];
  const r = await deps.runChild({
    command: "ffmpeg", args: ["-nostdin", "-hide_banner", "-y", "-protocol_whitelist", "file", "-i", raw, "-af", `loudnorm=I=${TARGET_LUFS}:TP=${CEILING_DBFS}`, "-c:a", "libmp3lame", "-b:a", "128k", norm],
    cwd: ctx.attemptDir, cwdRoot: ctx.attemptDir, timeoutMs: 120_000, maxOutputBytes: 1024 * 1024, signal: ctx.signal, onLine: (l) => out.push(l), stageRunId: ctx.claim.stageRunId,
  });
  if (r.code !== 0 || r.truncated || r.timedOut || r.aborted) throw new KnownFailure(`The clip was generated and paid for but could not be levelled; it is kept as ${rawRel} and a retry reuses it.`);

  const sha256 = createHash("sha256").update(await readFile(norm)).digest("hex");
  const rel = `generated/${sha256.slice(0, 16)}.mp3`;
  await copyFile(norm, path.join(deps.audioRoot, rel));
  const m = await measure(deps, deps.audioRoot, path.join(deps.audioRoot, rel));
  return addAudioItem(deps.db, {
    kind: need.kind, name: Array.from(prompt).slice(0, 60).join(""), tags: need.tags, source: "generated", licence: art.provenance.licence ?? "", filePath: rel, sha256, ...m,
    provenance: { ...art.provenance, normalised: { targetLufs: TARGET_LUFS, ceilingDbfs: CEILING_DBFS } },
  });
}
