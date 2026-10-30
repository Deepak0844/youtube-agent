import type pg from "pg";
import { KnownFailure } from "@/server/core/paid-call";
import type { StageContext } from "@/server/core/stage-handler";
import { ensureScopeCopies, periodScopes, videoTemplate } from "@/server/db/budget-scopes";
import { getBudget } from "@/server/db/spend";
import { latestContent, type ContentKind, type VideoFormat, type VideoKind, type VideoLanguage } from "@/server/db/videos";
import type { ImageProvider } from "@/server/providers/media";
import type { Renderer } from "@/server/providers/renderer";
import type { CaptionsBody } from "@/server/core/alignment";
import type { Lang } from "@/server/core/lang";
import type { VoiceProvider } from "@/server/providers/voice";
import type { AlignArgs } from "@/server/render/whisper";
import type { MixDeps } from "@/server/render/mix";
import type { probeVideo } from "@/server/render/probe";
import { videoIdOf } from "./attempt";

/** `providerId` is the registry id: it is part of every cached line's key, so two providers never share a cached line. */
export interface VoiceChoice {
  provider: VoiceProvider;
  providerId: string;
  voice: string;
  model?: string;
}

// Everything the Phase 2 stage handlers need, injected. The dry run passes the Task 15 fakes; real adapters arrive later.
export interface StageDeps {
  db: pg.Pool;
  /** Absolute storage root (the same path for web, worker and render runner). */
  root: string;
  /**
   * The routed narration voice for this video, or a KnownFailure("Pick a voice provider in Settings → Providers") BEFORE anything is
   * reserved. The adapter it returns reserves and pays inside its own ctx.paid, once per call, against `budgetScopes`.
   */
  voiceFor(a: { lang: Lang; format: VideoFormat; kind: VideoKind; budgetScopes: string[] }): Promise<VoiceChoice>;
  /** Word times for audio whose provider gave none (whisper). Absent or failing = estimated times, never invented exact ones. */
  align?: (a: AlignArgs) => Promise<CaptionsBody>;
  image: ImageProvider;
  renderer: Renderer;
  /** Defaults to the real ffprobe-based probe. */
  probe?: typeof probeVideo;
  /** Name Build writes into the plan; Generate refuses a plan that names another provider. */
  imageProvider?: string;
  /** Image model id passed to the provider (default "fake"). */
  imageModel?: string;
  /** Price Build quotes per image (default 4000 micro-USD = what the fake image provider charges). */
  imageQuoteMicroUsd?: number;
  /** How many beat images Build plans at most (default 3). */
  maxImages?: number;
  /** Real sound pass (ffmpeg). Absent = dry run: Voice and Sfx copy the file on. */
  mix?: MixDeps;
}

export const DEFAULTS = { imageProvider: "fake-image", imageModel: "fake", imageQuoteMicroUsd: 4000, maxImages: 3 } as const;

export const SIZE = { width: 1080, height: 1920 } as const;

export interface VideoInfo {
  id: string;
  kind: VideoKind;
  format: VideoFormat;
  language: VideoLanguage;
}

export async function loadVideo(db: pg.Pool, ctx: StageContext): Promise<VideoInfo> {
  const id = videoIdOf(ctx);
  const r = await db.query<{ kind: VideoKind; format: VideoFormat; language: VideoLanguage }>("select kind, format, language from videos where id = $1", [id]);
  if (!r.rows[0]) throw new KnownFailure("The video for this stage no longer exists.");
  return { id, ...r.rows[0] };
}

/**
 * Budget scopes for money spent on one video: its own copy of the per-video cap, and this UTC day and month. Copies come from
 * ensureScopeCopies/periodScopes (never the template rows, which would add up forever).
 */
export async function videoMoneyScopes(db: pg.Pool, v: VideoInfo): Promise<string[]> {
  return ensureScopeCopies(db, [[`video:${v.id}`, videoTemplate(v.kind, v.format)], ...(await periodScopes(db))]).catch((e: unknown) => {
    throw new KnownFailure(e instanceof Error ? e.message : "budget caps are not set up");
  });
}

/** The smallest amount any of these scopes can still take (cap - reserved - spent), with the scope that sets it. */
export async function scopeHeadroom(db: pg.Pool, scopes: readonly string[]): Promise<{ micro: number; scope: string }> {
  let min: { micro: number; scope: string } | null = null;
  for (const scope of scopes) {
    const b = await getBudget(db, scope);
    if (!b) throw new KnownFailure("budget caps are not set up");
    // no limit (null cap) leaves unlimited room; it is never read as zero
    const room = b.capMicroUsd === null ? Number.MAX_SAFE_INTEGER : Math.max(0, b.capMicroUsd - b.reservedMicroUsd - b.spentMicroUsd);
    if (!min || room < min.micro) min = { micro: room, scope };
  }
  if (!min) throw new KnownFailure("budget caps are not set up");
  return min;
}

export function plainScope(scope: string): string {
  return scope.startsWith("video:") ? "this video's cap" : scope.startsWith("day:") ? "today's cap" : scope.startsWith("month:") ? "this month's cap" : "a spending cap";
}

export async function contentBody<T = Record<string, unknown>>(db: pg.Pool, videoId: string, kind: ContentKind): Promise<T> {
  const row = await latestContent(db, videoId, kind);
  if (!row || row.body === null || typeof row.body !== "object") throw new KnownFailure(`This stage needs the ${kind}, and it is missing. Run the earlier stage again.`);
  return row.body as T;
}
