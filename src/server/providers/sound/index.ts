import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile } from "node:fs/promises";
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

const TARGET_LUFS = -20;
const CEILING_DBFS = -1.5;

/** Library first; generate only when allowed. A failed generation is thrown as is: never swapped for a library track. */
export async function ensureSound(ctx: StageContext, deps: SoundDeps, need: SoundNeed): Promise<AudioItem> {
  // findLibraryFirst matches on shared tags only, so an empty list would always miss and then pay.
  if (need.tags.length === 0) throw new KnownFailure("A sound needs at least one tag so the library can be searched.");
  const [hit] = await findLibraryFirst(deps.db, { kind: need.kind, tags: need.tags });
  if (hit) return hit;
  if (!deps.generateAllowed) throw new KnownFailure("No sound in the library matches, and generating a new one is not allowed. Choose \"generate\", or pick a library track yourself.");

  const a = { prompt: need.prompt, seconds: need.seconds };
  const art = need.kind === "sfx" ? await deps.provider.makeSfx(ctx, a) : await deps.provider.makeMusic(ctx, a);

  const norm = path.join(ctx.attemptDir, `norm-${art.sha256.slice(0, 12)}.mp3`);
  const out: string[] = [];
  const r = await deps.runChild({
    command: "ffmpeg", args: ["-nostdin", "-hide_banner", "-y", "-protocol_whitelist", "file", "-i", art.path, "-af", `loudnorm=I=${TARGET_LUFS}:TP=${CEILING_DBFS}`, "-c:a", "libmp3lame", "-b:a", "128k", norm],
    cwd: ctx.attemptDir, cwdRoot: ctx.attemptDir, timeoutMs: 120_000, maxOutputBytes: 1024 * 1024, signal: ctx.signal, onLine: (l) => out.push(l), stageRunId: ctx.claim.stageRunId,
  });
  if (r.code !== 0 || r.truncated || r.timedOut || r.aborted) throw new KnownFailure("The generated sound could not be levelled.");

  const sha256 = createHash("sha256").update(await readFile(norm)).digest("hex");
  const rel = `generated/${sha256.slice(0, 16)}.mp3`;
  await mkdir(path.join(deps.audioRoot, "generated"), { recursive: true });
  await copyFile(norm, path.join(deps.audioRoot, rel));
  const m = await measure(deps, deps.audioRoot, path.join(deps.audioRoot, rel));
  return addAudioItem(deps.db, {
    kind: need.kind, name: need.prompt.slice(0, 60), tags: need.tags, source: "generated", licence: art.provenance.licence ?? "", filePath: rel, sha256, ...m,
    provenance: { ...art.provenance, normalised: { targetLufs: TARGET_LUFS, ceilingDbfs: CEILING_DBFS } },
  });
}
