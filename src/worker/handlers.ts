import { lstatSync, realpathSync } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type pg from "pg";
import { createDraftHandler } from "@/server/authoring/draft";
import { DRY_RUN_NOTES } from "@/lib/dry-run";
import { KnownFailure } from "@/server/core/paid-call";
import { STAGE_NAMES, stagePlan, type StageName } from "@/server/core/pipeline-plan";
import { createSemaphore } from "@/server/core/semaphore";
import type { StageHandler } from "@/server/core/stage-handler";
import { AssetRefused, getAsset, registerAsset } from "@/server/db/assets";
import { recordAudit } from "@/server/db/audit";
import { assetsForVideo } from "@/server/db/video-assets";
import { assetForJob, claimIngestJob, expireReceiving, loadLimits, MAX_INGEST_TRIES, markDone, markRejected, requeueJob, runningIngestIds } from "@/server/db/ingest-jobs";
import { loadKeyring } from "@/server/db/master-key";
import { createLlmClient } from "@/server/llm/client";
import { defaultModelDeps } from "@/server/llm/default-deps";
import { createWebTools } from "@/server/llm/web-tools";
import { createPictureFetcher } from "@/server/providers/stock/picture-download";
import { secretName } from "@/server/core/provider-keys";
import { getSecret, hasSecret } from "@/server/db/vault";
import { createImageFor } from "@/server/providers/image/wire";
import { createFakeImage } from "@/server/providers/media/fake";
import { createFakeRenderer } from "@/server/providers/renderer/fake";
import { createContainerRenderer, resolveRenderImage, sweepRenderContainers } from "@/server/providers/renderer/remotion-container";
import { createThumbnailRenderer } from "@/server/providers/renderer/thumbnail-container";
import { createNativeRenderer } from "@/server/providers/renderer/remotion-native";
import { checkNativeRenderReady } from "@/server/providers/renderer/native-preflight";
import { createTsxRenderer } from "@/server/providers/renderer/tsx-render";
import { isWorkerAlive } from "@/server/db/child-processes";
import type { WorkerHooks } from "./runtime";
import { probeVideo } from "@/server/render/probe";
import { createFakeVoice } from "@/server/providers/voice/fake";
import { runChild, type ChildRegistry } from "@/server/render/child";
import { scanVideo } from "@/server/render/qa-scan";
import { ingestAudio, ingestImage, type IngestDeps } from "@/server/render/ingest";
import { storageRoot } from "@/server/storage/paths";
import { createVoiceFor, whisperAligner } from "./stages/voice-for";
import { withAttempt } from "./stages/attempt";
import { buildAttempt } from "./stages/build";
import { repairScenesAttempt } from "./stages/repair-scenes";
import { reframeAttempt } from "./stages/reframe";
import { deriveAttempt } from "./stages/derive";
import { thumbnailAttempt } from "./stages/thumbnail";
import { replyDraftsAttempt } from "./stages/reply-drafts";
import { seoAttempt } from "./stages/seo";
import type { StageDeps } from "./stages/deps";
import { dryRunDraftHandler } from "./stages/draft";
import { generateAttempt } from "./stages/generate";
import { dryRunPicturesHandler, picturesHandler } from "./stages/pictures";
import { outlineAttempt } from "./stages/outline";
import { qaAttempt } from "./stages/qa";
import { renderAttempt } from "./stages/render";
import { tsxAuthorAttempt } from "./stages/tsx-author";
import { directScene3dAttempt } from "./stages/direct-scene3d";
import { scene3dStillsAttempt } from "./stages/scene3d-stills";
import { scene3dAuthorAttempt } from "./stages/scene3d-author";
import { scene3dReviewAttempt } from "./stages/scene3d-review";
import { loadRepoCatalog } from "@/server/providers/renderer/scene3d-models";
import { sfxHandler } from "./stages/sfx";
import { ttsAttempt } from "./stages/tts";
import { voiceAttempt } from "./stages/voice";

// Tasks 15/20 supply concrete handlers. There is deliberately no fake production fallback.
export type StageHandlers = Partial<Record<StageName, StageHandler>>;
export function createStageDispatcher(handlers: StageHandlers, concurrentRenders: number): StageHandler {
  const render = createSemaphore(concurrentRenders);
  const resources = new Map([...stagePlan("scene_kit", "short", { paidGeneration: true, requireEvidence: true }), ...stagePlan("tsx", "short", { paidGeneration: false, requireEvidence: false }), ...stagePlan("scene3d", "short", { paidGeneration: false, requireEvidence: false }), ...stagePlan("scene3d_code", "short", { paidGeneration: false, requireEvidence: false })].map((s) => [s.stage, s.resource]));
  return async (ctx) => {
    const name = ctx.stage.name;
    if (!(STAGE_NAMES as readonly string[]).includes(name)) throw new KnownFailure("unknown stage");
    const handler = Object.hasOwn(handlers, name) ? handlers[name as StageName] : undefined;
    if (!handler) throw new KnownFailure(`missing stage handler: ${name}`);
    const run = async () => {
      if (ctx.signal.aborted) throw ctx.signal.reason;
      return handler(ctx);
    };
    return resources.get(name as StageName) === "render" ? render.run(run) : run();
  };
}

/** Fake providers on the real storage root: what the dry run (and its tests) wire in. Never used by the production worker. */
export function defaultDryRunDeps(pool: pg.Pool, root: string = storageRoot()): StageDeps {
  const voice = createFakeVoice();
  return { db: pool, root, voiceFor: async (a) => ({ provider: voice.forScopes(a.budgetScopes), providerId: "fake", voice: "fake" }), image: createFakeImage(), renderer: createFakeRenderer() };
}

/**
 * Every stage on fake providers (Task 20). Draft is the real Draft handler on a scripted model; the other seven write
 * only into their attempt folder and return file names, and `withAttempt` promotes them (fenced) before the stage commits.
 * Deliberately separate from productionHandlers: there is no fake fallback in production.
 */
export function dryRunHandlers(deps: StageDeps): StageHandlers {
  const fin = { db: deps.db, root: deps.root };
  return {
    outline: withAttempt(fin, outlineAttempt(deps)),
    draft: dryRunDraftHandler(deps.db),
    pictures: dryRunPicturesHandler,
    build: withAttempt(fin, buildAttempt(deps)),
    generate: withAttempt(fin, generateAttempt(deps)),
    tts: withAttempt(fin, ttsAttempt(deps)),
    render: withAttempt(fin, renderAttempt(deps)),
    tsx_author: withAttempt(fin, tsxAuthorAttempt(deps)),
    direct_scene3d: withAttempt(fin, directScene3dAttempt(deps)),
    scene3d_stills: withAttempt(fin, scene3dStillsAttempt(deps)),
    scene3d_author: withAttempt(fin, scene3dAuthorAttempt(deps)),
    scene3d_review: withAttempt(fin, scene3dReviewAttempt(deps)),
    voice: withAttempt(fin, voiceAttempt(deps)),
    sfx: sfxHandler(fin, deps),
    qa: withAttempt(fin, qaAttempt(deps)),
    repair_scenes: repairScenesAttempt(deps),
    reframe: withAttempt(fin, reframeAttempt(deps)),
    thumbnail: withAttempt(fin, thumbnailAttempt(deps)),
    derive: withAttempt(fin, deriveAttempt(deps)),
    seo: withAttempt(fin, seoAttempt(deps)),
  };
}

/**
 * remotion/kit next to this module (never the working directory). Symlinks on the way are resolved, but a kit folder that
 * is itself a symlink or is missing is passed as is, and the renderer refuses it (no docker -v ever creates a folder).
 */
export function renderKitDir(here: string = import.meta.dirname): string {
  const kit = path.resolve(here, "..", "..", "remotion", "kit");
  return lstatSync(kit, { throwIfNoEntry: false })?.isDirectory() ? realpathSync(kit) : kit;
}

/**
 * Worker hooks for the real worker: after taking its lock it removes render containers whose worker is dead (a live
 * sibling's renders are kept). The dry run gets none, so it never touches Docker containers.
 */
export function workerHooksFor(pool: pg.Pool, env: Record<string, string | undefined>): Partial<WorkerHooks> {
  if (env.ENGINE_DRY_RUN === "1") return {};
  return { sweepRenderContainers: () => sweepRenderContainers({ isAlive: (id) => isWorkerAlive(pool, id) }) };
}

const notWired = (): never => { throw new KnownFailure("This step is not wired in production yet."); };

/**
 * Real deps for the voice, mux and sound stages. Every ffmpeg/ffprobe/whisper child goes through the worker's registry
 * (which already carries the worker id), so a crash leaves them in child_processes for the orphan sweep.
 */
export function productionStageDeps(pool: pg.Pool, env: { childRegistry?: ChildRegistry; workerId?: string } = {}, root: string = storageRoot()): StageDeps {
  const run = (spec: Parameters<typeof runChild>[0]) => runChild(spec, { registry: env.childRegistry });
  const image = resolveRenderImage(); // once, at worker boot: renders run the image by its sha256 id (tag fallback is logged)
  const nativeRenderer = createNativeRenderer({
    root, kitDir: renderKitDir(), runChild: run, probe: (file, signal) => probeVideo(file, signal, { storageRoot: root }),
    preflight: () => checkNativeRenderReady({ repoRoot: path.resolve(renderKitDir(), "..", ".."), storageRoot: root }),
    catalog: () => loadRepoCatalog(path.resolve(renderKitDir(), "..", "..")),
  });
  return {
    db: pool, root, voiceFor: createVoiceFor(pool, () => loadKeyring()), align: whisperAligner(run),
    qaScan: scanVideo,
    mix: { runChild: run, audioRoot: path.join(root, "audio") },
    // Build plans no paid images (empty cost plan); generate is not wired. Nothing calls image, and if it did it refuses.
    paidImages: false,
    // Pictures linked to beats (video_assets): Build plans those beats itself; repair sees the same ids.
    sceneAssets: async (videoId) => [...new Set((await assetsForVideo(pool, videoId)).map((a) => a.assetId))],
    scenePictures: (videoId) => assetsForVideo(pool, videoId),
    imageFor: createImageFor(pool, () => loadKeyring(), root),
    image: { capability: { id: "none", refImages: false, seed: false, aspects: [], maxRefs: 0 }, quote: notWired, generate: notWired },
    // Code scenes (tsx_author): the same container locks plus tighter limits (tsx-sandbox.ts); the model's file never touches the host shell.
    tsx: createTsxRenderer({ kitDir: renderKitDir(), runChild: run, image: () => image, workerId: env.workerId, probe: (file, signal) => probeVideo(file, signal, { storageRoot: root }) }),
    // The long-video thumbnail card: the same container locks, mode --thumbnail (thumbnail-container.ts).
    thumbnails: createThumbnailRenderer({ root, kitDir: renderKitDir(), runChild: run, image: () => image, workerId: env.workerId }),
    // Render runs in the locked-down render container (remotion-container.ts). The kit is read from the repo the worker runs in.
    renderer: createContainerRenderer({
      root, kitDir: renderKitDir(), runChild: run, image: () => image, workerId: env.workerId,
      assetFile: async (id) => { const a = await getAsset(pool, id); return a && !a.deletedAt && (a.kind === "image" || a.kind === "video") ? a.storageRef : null; },
      probe: (file, signal) => probeVideo(file, signal, { storageRoot: root }),
    }),
    catalog3d: () => loadRepoCatalog(path.resolve(renderKitDir(), "..", "..")),
    // 3D videos on this Mac's GPU, inside sandbox-exec (remotion-native.ts). Used only when render.native_3d is on and the preflight is ready.
    native: {
      renderer: nativeRenderer,
      stills: nativeRenderer, // the preview pictures of 3D stories: the same sandboxed job, another mode
      ready: () => checkNativeRenderReady({ repoRoot: path.resolve(renderKitDir(), "..", ".."), storageRoot: root }),
    },
  };
}

/**
 * The handlers the real worker runs: draft, build (no paid images), tts, render (container), voice (mux), sfx (mixer) and qa.
 * generate stays absent (refused as "missing stage handler"): paid image generation is gated until Phase 8.
 */
export function productionHandlers(pool: pg.Pool, env: { childRegistry?: ChildRegistry; workerId?: string } = {}): StageHandlers {
  const draft: StageHandler = async (ctx) => {
    const searxUrl = process.env.SEARXNG_URL;
    if (!searxUrl) throw new KnownFailure("Web search is not set up (SEARXNG_URL), so a draft cannot be written.");
    const models = await defaultModelDeps(pool, () => loadKeyring());
    return createDraftHandler({
      db: pool,
      makeLlm: (scopes) => createLlmClient({ db: pool, ...models, budgetScopes: () => scopes }),
      makeWeb: () => createWebTools({ searxUrl }),
    })(ctx);
  };
  const deps = productionStageDeps(pool, env);
  const fin = { db: deps.db, root: deps.root };
  // Same model wiring as Draft, routed to 'build_scene_kit'. No route / unpriced model = a plain refusal before anything is reserved; no other model is tried.
  const build: StageHandler = async (ctx) => {
    const models = await defaultModelDeps(pool, () => loadKeyring());
    return withAttempt(fin, buildAttempt({ ...deps, makeLlm: (scopes) => createLlmClient({ db: pool, ...models, budgetScopes: () => scopes }) }))(ctx);
  };
  // Long videos: the 'outline' model route and the video's budget scopes (the long-video cap); refuses before anything is reserved when none is routed.
  const outline: StageHandler = async (ctx) => {
    const models = await defaultModelDeps(pool, () => loadKeyring());
    return withAttempt(fin, outlineAttempt({ ...deps, makeLlm: (scopes) => createLlmClient({ db: pool, ...models, budgetScopes: () => scopes }) }))(ctx);
  };
  // Code scenes: the Build model route and budget scopes (so Claude Code at $0 or any priced model works); refuses before anything is reserved when none is routed.
  const tsxAuthor: StageHandler = async (ctx) => {
    const models = await defaultModelDeps(pool, () => loadKeyring());
    return withAttempt(fin, tsxAuthorAttempt({ ...deps, makeLlm: (scopes) => createLlmClient({ db: pool, ...models, budgetScopes: () => scopes }) }))(ctx);
  };
  // 3D scene videos: the direct_scene3d model route and the same budget scopes as Build; the catalogue comes from the repo the worker runs in.
  const directScene3d: StageHandler = async (ctx) => {
    const models = await defaultModelDeps(pool, () => loadKeyring());
    return withAttempt(fin, directScene3dAttempt({ ...deps, makeLlm: (scopes) => createLlmClient({ db: pool, ...models, budgetScopes: () => scopes }) }))(ctx);
  };
  // 3D story, AI-written scene: the author_scene3d model route and the same budget scopes as Build; checks and the type-check run in this worker, nothing runs until the sandboxed render.
  const scene3dAuthor: StageHandler = async (ctx) => {
    const models = await defaultModelDeps(pool, () => loadKeyring());
    return withAttempt(fin, scene3dAuthorAttempt({ ...deps, makeLlm: (scopes) => createLlmClient({ db: pool, ...models, budgetScopes: () => scopes }) }))(ctx);
  };
  // Preview pictures of a 3D story: native pictures, then the optional (advisory) picture check through the review_frames vision route.
  const scene3dStills: StageHandler = async (ctx) => {
    const models = await defaultModelDeps(pool, () => loadKeyring());
    return withAttempt(fin, scene3dStillsAttempt({ ...deps, makeLlm: (scopes) => createLlmClient({ db: pool, ...models, budgetScopes: () => scopes }) }))(ctx);
  };
  // On demand only (never in the route): same model wiring and budget scopes as Build; saves its own scenes version.
  const repair: StageHandler = async (ctx) => {
    const models = await defaultModelDeps(pool, () => loadKeyring());
    return repairScenesAttempt({ ...deps, makeLlm: (scopes) => createLlmClient({ db: pool, ...models, budgetScopes: () => scopes }) })(ctx);
  };
  // On demand only: the 'titles' model route, same wiring and budget scopes as Build.
  const seo: StageHandler = async (ctx) => {
    const models = await defaultModelDeps(pool, () => loadKeyring());
    return withAttempt(fin, seoAttempt({ ...deps, makeLlm: (scopes) => createLlmClient({ db: pool, ...models, budgetScopes: () => scopes }) }))(ctx);
  };
  // On demand only: the 'comment_replies' model route. Saves HELD drafts; it never posts anything.
  const replyDrafts: StageHandler = async (ctx) => {
    const models = await defaultModelDeps(pool, () => loadKeyring());
    return withAttempt(fin, replyDraftsAttempt({ ...deps, makeLlm: (scopes) => createLlmClient({ db: pool, ...models, budgetScopes: () => scopes }) }))(ctx);
  };
  return {
    outline: refuseDryRunVideos(pool, outline),
    draft: refuseDryRunVideos(pool, draft),
    pictures: refuseDryRunVideos(pool, picturesHandler({
      db: pool, root: deps.root, ingest: { runChild: (spec) => runChild(spec, { registry: env.childRegistry }) },
      fetcher: createPictureFetcher(), // safeFetch indirect (public addresses only), no redirects, 30 s

      pixabayKey: async () => {
        try {
          const name = secretName("pixabay");
          return (await hasSecret(pool, name)) ? await getSecret(pool, loadKeyring(), name) : null;
        } catch {
          return null; // no master key or unreadable: Pixabay is simply skipped
        }
      },
    })),
    repair_scenes: refuseDryRunVideos(pool, repair),
    reframe: refuseDryRunVideos(pool, withAttempt(fin, reframeAttempt(deps))),
    thumbnail: refuseDryRunVideos(pool, withAttempt(fin, thumbnailAttempt(deps))),
    derive: refuseDryRunVideos(pool, withAttempt(fin, deriveAttempt(deps))),
    seo: refuseDryRunVideos(pool, seo),
    reply_drafts: refuseDryRunVideos(pool, replyDrafts),
    build: refuseDryRunVideos(pool, build),
    tts: refuseDryRunVideos(pool, withAttempt(fin, ttsAttempt(deps))),
    render: refuseDryRunVideos(pool, withAttempt(fin, renderAttempt(deps))),
    tsx_author: refuseDryRunVideos(pool, tsxAuthor),
    direct_scene3d: refuseDryRunVideos(pool, directScene3d),
    scene3d_stills: refuseDryRunVideos(pool, scene3dStills),
    scene3d_author: refuseDryRunVideos(pool, scene3dAuthor),
    scene3d_review: refuseDryRunVideos(pool, withAttempt(fin, scene3dReviewAttempt(deps))),
    voice: refuseDryRunVideos(pool, withAttempt(fin, voiceAttempt(deps))),
    sfx: refuseDryRunVideos(pool, sfxHandler(fin, deps)),
    qa: refuseDryRunVideos(pool, withAttempt(fin, qaAttempt(deps))),
  };
}

/** A video made by the dry-run button must never reach a real provider, even if the worker was started without the dry-run opt-in. */
export function refuseDryRunVideos(pool: pg.Pool, inner: StageHandler): StageHandler {
  return async (ctx) => {
    if (ctx.stage.videoId) {
      const r = await pool.query("select 1 from videos where id = $1 and notes = $2", [ctx.stage.videoId, DRY_RUN_NOTES]);
      if (r.rowCount === 1) throw new KnownFailure("This is a dry-run video and this worker uses real providers. Start the worker with ENGINE_DRY_RUN=1 (throwaway database) to run it.");
    }
    return inner(ctx);
  };
}

class IngestRefused extends Error {}

const exists = (f: string): Promise<boolean> => stat(f).then(() => true, () => false);
const INTERRUPTED = "Interrupted. Upload it again.";

/**
 * Worker start (one worker holds the lock, so a `running` row belongs to a dead one). The asset may already be registered
 * (done); else if the spooled file is still there the job goes back to the queue; else the bytes are gone and the owner
 * is asked to upload again. Never deletes files.
 */
export async function recoverRunningIngest(pool: pg.Pool, root: string): Promise<void> {
  for (const id of await runningIngestIds(pool)) {
    if (await assetForJob(pool, id)) await finishRegistered(pool, id);
    else if (await exists(path.join(root, "assets-incoming", id))) await requeueJob(pool, id);
    else await markRejected(pool, id, INTERRUPTED);
  }
}

/** Ends upload rows that never finished arriving and removes their partial files. */
export async function sweepStaleUploads(pool: pg.Pool, root: string): Promise<void> {
  for (const id of await expireReceiving(pool)) {
    await rm(path.join(root, "assets-incoming", `${id}.part`), { force: true });
    await rm(path.join(root, "assets-incoming", id), { force: true });
  }
}

async function finishRegistered(pool: pg.Pool, jobId: string): Promise<void> {
  const assetId = await assetForJob(pool, jobId);
  if (!assetId) return;
  await markDone(pool, jobId, assetId);
  await recordAudit(pool, "asset.added", { job: jobId, assetId, recovered: true });
}

/**
 * The `ingest` job: checks one spooled upload in the sandbox and writes the assets row, or rejects it with a plain reason.
 * Redelivery-safe: only a `queued` row can be claimed, so a duplicate or replayed job does nothing. Nothing here builds a
 * path from the file name: both folders are job ids. The assets row and the job's `done` are one transaction, and once
 * the row exists its files are never deleted here.
 */
export async function handleIngestJob(pool: pg.Pool, deps: IngestDeps & { root: string }, jobId: string): Promise<{ ran: boolean }> {
  const job = await claimIngestJob(pool, jobId);
  if (!job || !job.kind) return { ran: false };
  if (await assetForJob(pool, job.id)) {
    await finishRegistered(pool, job.id); // a run that registered the asset but died before finishing: nothing to redo
    return { ran: true };
  }
  const src = path.join(deps.root, "assets-incoming", job.id);
  const rel = `assets/${job.id}`;
  const dest = path.join(deps.root, rel);
  let assetId: string;
  let duplicate: boolean;
  try {
    await mkdir(dest, { recursive: true });
    const limits = await loadLimits(pool);
    const args = { srcPath: src, destDir: dest, stageRunId: job.id };
    const r = job.kind === "image"
      ? await ingestImage(deps, { ...args, maxBytes: limits.maxImageBytes, maxPixels: limits.maxPixels })
      : await ingestAudio(deps, { ...args, maxBytes: limits.maxAudioBytes });
    if (!r.ok) throw new IngestRefused(r.message);
    const refs = Object.fromEntries(Object.entries(r.files).map(([role, f]) => [role, `${rel}/${path.basename(f)}`]));
    const { main, ...derivedRefs } = refs;
    const client = await pool.connect();
    try {
      await client.query("begin");
      const reg = await registerAsset(client, {
        kind: r.kind, originalName: job.originalName, mime: r.mime, bytes: r.bytes, width: r.width, height: r.height, durationS: r.durationS,
        sha256: r.sha256, storageRef: main!, derivedRefs, tags: job.tags, caption: job.caption, rights: job.rights, keep: job.keep,
        containsPerson: job.containsPerson, voiceCloneReference: job.voiceClone,
      });
      assetId = reg.asset.id;
      duplicate = reg.duplicate;
      await markDone(client, job.id, assetId);
      await client.query("commit");
    } catch (e) {
      await client.query("rollback").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  } catch (err) {
    // Nothing was registered (the transaction is all-or-nothing), so this run's output can go.
    await rm(dest, { recursive: true, force: true }).catch(() => undefined); // cleanup must not hide the real failure
    if (err instanceof AssetRefused || err instanceof IngestRefused) {
      await rm(src, { force: true });
      await markRejected(pool, job.id, err.message);
      await recordAudit(pool, "asset.upload_refused", { job: job.id, kind: job.kind });
    } else if (await exists(src) && job.attempts < MAX_INGEST_TRIES) {
      await requeueJob(pool, job.id); // a transient failure before the file was touched: try again
    } else if (await exists(src)) {
      await rm(src, { force: true });
      await markRejected(pool, job.id, "Could not be processed after several tries. Upload it again.");
      await recordAudit(pool, "asset.upload_refused", { job: job.id, kind: job.kind });
    } else {
      await markRejected(pool, job.id, INTERRUPTED);
      await recordAudit(pool, "asset.upload_refused", { job: job.id, kind: job.kind });
    }
    return { ran: true };
  }
  if (duplicate) await rm(dest, { recursive: true, force: true }).catch(() => undefined); // the first copy's files stay
  await recordAudit(pool, "asset.added", { job: job.id, kind: job.kind, assetId, duplicate }).catch(() => undefined);
  return { ran: true };
}
