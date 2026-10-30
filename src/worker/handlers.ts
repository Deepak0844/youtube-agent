import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type pg from "pg";
import { createDraftHandler } from "@/server/authoring/draft";
import { DRY_RUN_NOTES } from "@/lib/dry-run";
import { KnownFailure } from "@/server/core/paid-call";
import { STAGE_NAMES, stagePlan, type StageName } from "@/server/core/pipeline-plan";
import { createSemaphore } from "@/server/core/semaphore";
import type { StageHandler } from "@/server/core/stage-handler";
import { AssetRefused, registerAsset } from "@/server/db/assets";
import { recordAudit } from "@/server/db/audit";
import { assetForJob, claimIngestJob, expireReceiving, loadLimits, MAX_INGEST_TRIES, markDone, markRejected, requeueJob, runningIngestIds } from "@/server/db/ingest-jobs";
import { loadKeyring } from "@/server/db/master-key";
import { createLlmClient } from "@/server/llm/client";
import { defaultModelDeps } from "@/server/llm/default-deps";
import { createWebTools } from "@/server/llm/web-tools";
import { createFakeImage } from "@/server/providers/media/fake";
import { createFakeRenderer } from "@/server/providers/renderer/fake";
import { createFakeVoice } from "@/server/providers/voice/fake";
import { runChild, type ChildRegistry } from "@/server/render/child";
import { ingestAudio, ingestImage, type IngestDeps } from "@/server/render/ingest";
import { storageRoot } from "@/server/storage/paths";
import { createVoiceFor, whisperAligner } from "./stages/voice-for";
import { withAttempt } from "./stages/attempt";
import { buildAttempt } from "./stages/build";
import type { StageDeps } from "./stages/deps";
import { dryRunDraftHandler } from "./stages/draft";
import { generateAttempt } from "./stages/generate";
import { qaAttempt } from "./stages/qa";
import { renderAttempt } from "./stages/render";
import { sfxHandler } from "./stages/sfx";
import { ttsAttempt } from "./stages/tts";
import { voiceAttempt } from "./stages/voice";

// Tasks 15/20 supply concrete handlers. There is deliberately no fake production fallback.
export type StageHandlers = Partial<Record<StageName, StageHandler>>;
export function createStageDispatcher(handlers: StageHandlers, concurrentRenders: number): StageHandler {
  const render = createSemaphore(concurrentRenders);
  const resources = new Map(stagePlan("scene_kit", "short", { paidGeneration: true, requireEvidence: true }).map((s) => [s.stage, s.resource]));
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
    draft: dryRunDraftHandler(deps.db),
    build: withAttempt(fin, buildAttempt(deps)),
    generate: withAttempt(fin, generateAttempt(deps)),
    tts: withAttempt(fin, ttsAttempt(deps)),
    render: withAttempt(fin, renderAttempt(deps)),
    voice: withAttempt(fin, voiceAttempt(deps)),
    sfx: sfxHandler(fin, deps),
    qa: withAttempt(fin, qaAttempt(deps)),
  };
}

const notWired = (): never => { throw new KnownFailure("This step is not wired in production yet."); };

/**
 * Real deps for the voice, mux and sound stages. Every ffmpeg/ffprobe/whisper child goes through the worker's registry
 * (which already carries the worker id), so a crash leaves them in child_processes for the orphan sweep.
 */
export function productionStageDeps(pool: pg.Pool, env: { childRegistry?: ChildRegistry } = {}, root: string = storageRoot()): StageDeps {
  const run = (spec: Parameters<typeof runChild>[0]) => runChild(spec, { registry: env.childRegistry });
  return {
    db: pool, root, voiceFor: createVoiceFor(pool, () => loadKeyring()), align: whisperAligner(run),
    mix: { runChild: run, audioRoot: path.join(root, "audio") },
    // build/generate/render are not wired in production yet (Phase 4); these stages never call them, and if one ever did it refuses.
    image: { capability: { id: "none", refImages: false, seed: false, aspects: [], maxRefs: 0 }, quote: notWired, generate: notWired },
    renderer: { render: notWired },
  };
}

/** The handlers the real worker runs: draft, tts, voice (mux) and sfx (mixer). build/generate/render/qa stay absent (refused as "missing stage handler"). */
export function productionHandlers(pool: pg.Pool, env: { childRegistry?: ChildRegistry } = {}): StageHandlers {
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
  return {
    draft: refuseDryRunVideos(pool, draft),
    tts: refuseDryRunVideos(pool, withAttempt(fin, ttsAttempt(deps))),
    voice: refuseDryRunVideos(pool, withAttempt(fin, voiceAttempt(deps))),
    sfx: refuseDryRunVideos(pool, sfxHandler(fin, deps)),
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
