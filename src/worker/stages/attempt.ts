import { createHash } from "node:crypto";
import { constants as fsc } from "node:fs";
import { copyFile, lstat, mkdir, open } from "node:fs/promises";
import path from "node:path";
import type pg from "pg";
import { KnownFailure, LeaseLostError } from "@/server/core/paid-call";
import type { StageContext, StageHandler } from "@/server/core/stage-handler";
import type { StageClaim } from "@/server/core/stage-runner";
import { saveStageContent, type ContentSave } from "@/server/db/stage-content";
import type { Claim } from "@/server/db/stages";
import type { ContentKind } from "@/server/db/videos";
import { attemptDir, safeJoin } from "@/server/storage/paths";
import { promoteAttempt } from "@/server/storage/store";

// How a stage's files reach the video folder (Doc 2 §9.1).
//
//   1. prepareAttempt: the handler gets `ctx.attemptDir` = <root>/videos/<id>/attempt-<stageRunId>-<fence>/ (created here).
//   2. The handler writes ONLY there and returns the file names (and the content versions) it wants.
//   3. finishAttempt, still inside the stage, promotes the files with promoteAttempt (fenced: running, same fence and owner,
//      lease alive, no cancel) and only then saves the content versions that point at them, also fenced. A worker that lost
//      the stage promotes nothing and saves nothing; its files stay in its attempt folder for the sweep.

export type OutContent = { kind: ContentKind; body: unknown } | { kind: ContentKind; file: string };

/** What an attempt handler returns. `files` are relative to the attempt folder; `content.file` is a plain file name in the video folder (promoted now or by an earlier stage). */
export interface StageOutput {
  files: string[];
  content?: OutContent[];
  result?: Record<string, unknown>;
}
export type AttemptHandler = (ctx: StageContext) => Promise<StageOutput>;

/** Names only the engine's own stages write. A provider that picks one of these could overwrite another stage's output. */
export const RESERVED_NAMES: ReadonlySet<string> = new Set(["scene.json", "scenes.json", "render.mp4", "voiced.mp4", "final.mp4", "review-first.png", "review-last.png"]);

/** A file name a provider chose: a plain name, not hidden, not one of the engine's own output names. */
export function assertProviderName(name: unknown, who: string): asserts name is string {
  if (typeof name !== "string" || name === "" || name !== path.basename(name) || name.startsWith(".") || RESERVED_NAMES.has(name)) {
    throw new KnownFailure(`The ${who} provider returned an unusable file name.`);
  }
}

export function videoIdOf(ctx: StageContext): string {
  if (!ctx.stage.videoId) throw new KnownFailure(`${ctx.stage.name} needs a video`);
  return ctx.stage.videoId;
}

/** Sets and creates this attempt's folder. Mode 0700: only the worker's user. */
export async function prepareAttempt(ctx: StageContext, root: string): Promise<string> {
  const dir = attemptDir(root, videoIdOf(ctx), ctx.claim.stageRunId, ctx.claim.fence);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  ctx.attemptDir = dir;
  return dir;
}

export async function openRegular(file: string) {
  const fh = await open(file, fsc.O_RDONLY | fsc.O_NOFOLLOW);
  try {
    if (!(await fh.stat()).isFile()) throw new KnownFailure("expected a regular file");
    return fh;
  } catch (e) {
    await fh.close();
    throw e;
  }
}

/** SHA-256 of a regular file's bytes, hashed while streaming (a large video is never held in memory). No symlinks followed. */
export async function sha256File(file: string): Promise<string> {
  const fh = await openRegular(file);
  const h = createHash("sha256");
  try {
    for await (const chunk of fh.createReadStream({ autoClose: false })) h.update(chunk as Buffer);
  } finally {
    await fh.close();
  }
  return h.digest("hex");
}

/** Absolute path of a promoted file of this video, proven to stay inside the storage root. Plain file names only. */
export async function promotedPath(root: string, videoId: string, name: string): Promise<string> {
  return safeJoin(root, "videos", videoId, name);
}

/** Copies a promoted file of this video into the attempt folder (no symlink followed, regular files only). */
export async function copyPromoted(root: string, ctx: StageContext, name: string, to: string): Promise<void> {
  const src = await promotedPath(root, videoIdOf(ctx), name);
  const st = await lstat(src).catch(() => null);
  if (!st || !st.isFile()) throw new KnownFailure(`The file ${name} from an earlier stage is missing. Run that stage again.`);
  await copyFile(src, path.join(ctx.attemptDir, to));
}

export interface FinishDeps {
  db: pg.Pool;
  root: string;
}

/** Promote, then save content. Returns the stage result. Throws LeaseLostError when the stage is no longer ours. */
export async function finishAttempt(deps: FinishDeps, ctx: StageContext, out: StageOutput): Promise<unknown> {
  ctx.signal.throwIfAborted();
  const videoId = videoIdOf(ctx);
  if (out.files.length > 0) {
    const ok = await promoteAttempt(deps.db, ctx.claim as StageClaim as Claim, out.files, { root: deps.root });
    if (!ok) throw new LeaseLostError(`promote:${ctx.claim.stageRunId}`);
  }
  const saves: ContentSave[] = [];
  for (const c of out.content ?? []) {
    if ("body" in c) {
      saves.push({ kind: c.kind, body: c.body });
    } else {
      // A file promoted just now, or one an earlier stage promoted (QA records the video Sfx made).
      const abs = await promotedPath(deps.root, videoId, c.file);
      saves.push({ kind: c.kind, filePath: `videos/${videoId}/${c.file}`, sha256: await sha256File(abs) });
    }
  }
  const versions = saves.length > 0 ? await saveStageContent(deps.db, videoId, ctx.claim, saves) : {};
  return { files: out.files, versions, ...(out.result ?? {}) };
}

/** A stage handler for the worker: prepare the folder, run the attempt handler, promote and save. */
export function withAttempt(deps: FinishDeps, inner: AttemptHandler): StageHandler {
  return async (ctx) => {
    await prepareAttempt(ctx, deps.root);
    const out = await inner(ctx);
    return finishAttempt(deps, ctx, out);
  };
}
