import { KnownFailure } from "@/server/core/paid-call";
import { clipProblem, quoteClip, type VideoModelCap } from "@/server/core/video-clip";
import type { Db } from "@/server/db/stages";
import { runAsyncMedia, stepOfKey } from "../async-media";
import { readKey } from "../image";
import type { JobChecker } from "../media-types";
import type { SafeFetch } from "../voice/eleven-types";
import { postJson, readCapped } from "../voice/elevenlabs";
import { getBytes, HttpStatusError, parseJson, plainHttpsUrl } from "./http";
import { clipScopes, MAX_CLIP_BYTES, saveClip, type ClipArgs, type VideoProvider } from "./index";
import { imageDataUrl } from "./seedance";

// Kling through its official API (singapore host). Written from the public docs: create POST /image-to-video/kling-3.0 or /kling-4.0
// (and /text-to-video/kling-4.0), Bearer key; query GET /tasks?task_ids=ID; video at data[].outputs[] with type "video". NOT proven against the real service.
const HOST = "https://api-singapore.klingai.com";
const TASK_ID = /^[A-Za-z0-9_-]{6,100}$/;
const ASPECTS = ["9:16", "16:9", "1:1"] as const;

/** Kling 3.0 only starts from a picture (3 to 15 s). Kling 4.0 takes a picture or words alone (3 to 30 s). The picture sets the shape. */
export const KLING_MODELS: Readonly<Record<string, VideoModelCap>> = {
  "kling-3.0": { id: "kling-3.0", imageToVideo: true, endFrame: true, audio: true, imageRequired: true, aspects: ASPECTS, minSeconds: 3, maxSeconds: 15 },
  "kling-4.0": { id: "kling-4.0", imageToVideo: true, endFrame: true, audio: false, aspects: ASPECTS, minSeconds: 3, maxSeconds: 30 },
};

export interface KlingDeps {
  /** Typed host api-singapore.klingai.com. */
  fetch: SafeFetch;
  /** Indirect (public-address-only) fetch for the result file; it never gets the key. */
  fetchCdn: SafeFetch;
  db: Db;
  getKey: () => Promise<string>;
  /** The `kling_video` registry price (per second); it must be the price for `resolution`. null = unpriced, refused. */
  price: unknown;
  root: string;
  resolution?: "720p" | "1080p";
  readImage: (storagePath: string) => Promise<Buffer>;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

type Task = { status?: unknown; outputs?: Array<{ type?: unknown; url?: unknown }> };
const videoUrl = (t: Task): unknown => t.outputs?.find((o) => o.type === "video")?.url;
const taskOf = (b: Buffer): Task | null => parseJson<{ data?: Task[] }>("Kling", b).data?.[0] ?? null;

export function createKlingJobChecker(deps: Pick<KlingDeps, "fetch" | "fetchCdn" | "getKey" | "root">): JobChecker {
  return {
    async check(job) {
      if (!TASK_ID.test(job.providerJobId)) return { kind: "unknown" };
      const signal = AbortSignal.timeout(300_000);
      try {
        const auth = { authorization: `Bearer ${await readKey(deps.getKey, "Kling")}` };
        let t: Task | null;
        try {
          t = taskOf(await getBytes("Kling", deps.fetch, `${HOST}/tasks?task_ids=${job.providerJobId}`, auth, signal));
        } catch (err) {
          if (err instanceof HttpStatusError && err.status === 404) return { kind: "failed", reason: "Kling has no record of this job." };
          throw err;
        }
        if (!t) return { kind: "unknown" };
        if (t.status === "submitted" || t.status === "processing") return { kind: "running" };
        if (t.status === "failed") return { kind: "failed", reason: "Kling reports that the job failed." };
        if (t.status !== "succeeded") return { kind: "unknown" };
        const bytes = await getBytes("Kling", deps.fetchCdn, plainHttpsUrl("Kling", videoUrl(t)).href, {}, signal, MAX_CLIP_BYTES);
        return { kind: "done", artifact: await saveClip(bytes, { root: deps.root, provider: "kling_video", model: "unknown", prompt: "", seconds: 0, aspect: "", priceMicroUsd: job.quoteMicroUsd }) };
      } catch {
        return { kind: "unknown" };
      }
    },
  };
}

export function createKlingVideo(deps: KlingDeps): VideoProvider {
  const resolution = deps.resolution ?? "720p";
  const check = (a: ClipArgs) => {
    const model = Object.hasOwn(KLING_MODELS, a.model) ? KLING_MODELS[a.model] : undefined;
    if (!model) throw new KnownFailure(`The Kling model "${a.model.slice(0, 60)}" is not supported.`);
    const why = clipProblem(model, a);
    if (why) throw new KnownFailure(why);
    if (a.startImage !== (a.startImagePath !== undefined) || a.endImage !== (a.endImagePath !== undefined)) throw new KnownFailure("A picture was announced but not given, or given but not announced.");
    return quoteClip(deps.price, a.seconds);
  };

  return {
    capability: { id: "kling_video", models: KLING_MODELS },
    quote: check,
    async generate(ctx, a) {
      const reserve = check(a);
      const scopes = clipScopes(a.budgetScopes);
      // Pictures are read BEFORE anything is reserved or submitted: a bad file is a plain refusal.
      const frames: Array<{ type: "first_frame" | "last_frame"; url: string }> = [];
      if (a.startImagePath) frames.push({ type: "first_frame", url: imageDataUrl(await deps.readImage(a.startImagePath)) });
      if (a.endImagePath) frames.push({ type: "last_frame", url: imageDataUrl(await deps.readImage(a.endImagePath)) });
      const withPicture = frames.length > 0;
      const path = `${withPicture ? "image-to-video" : "text-to-video"}/${a.model}`;
      // 3.0 can switch its own sound off; 4.0 has no such setting (the sound is dropped when the video is assembled).
      const settings = { duration: a.seconds, resolution, ...(a.model === "kling-3.0" && { audio: "off" }), ...(!withPicture && { aspect_ratio: a.aspect }) };
      const body = withPicture
        ? { contents: [{ type: "prompt", text: a.prompt }, ...frames], settings, options: { watermark_info: { enabled: false } } }
        : { prompt: a.prompt, settings, options: { watermark_info: { enabled: false } } };
      return ctx.paid({ reserveMicroUsd: reserve, budgetScopes: scopes, kind: "paid" }, async (callKey, signal) => {
        const auth = async () => ({ authorization: `Bearer ${await readKey(deps.getKey, "Kling")}` });
        let flaky = 0;
        const result = await runAsyncMedia(ctx, { db: deps.db, provider: "kling_video", kind: "video", step: stepOfKey(callKey), quoteMicroUsd: reserve, signal, sleep: deps.sleep }, {
          async submit() {
            const res = await postJson("Kling", deps.fetch, `${HOST}/${path}`, await auth(), body, signal);
            const id = parseJson<{ data?: { id?: unknown } }>("Kling", await readCapped(res, "Kling")).data?.id;
            if (typeof id !== "string" || !TASK_ID.test(id)) throw new Error("Kling returned no usable job id.");
            return id;
          },
          async poll(id) {
            let t: Task | null;
            try {
              t = taskOf(await getBytes("Kling", deps.fetch, `${HOST}/tasks?task_ids=${id}`, await auth(), signal));
              flaky = 0;
            } catch (err) {
              if (signal.aborted || ++flaky > 3) throw err;
              return null;
            }
            if (!t) throw new Error("Kling did not list this job; the outcome is unknown.");
            if (t.status === "submitted" || t.status === "processing") return null;
            if (t.status === "failed") throw new Error("Kling reported the job failed; the outcome is unknown.");
            if (t.status !== "succeeded") throw new Error("Kling reported an unknown job state.");
            return plainHttpsUrl("Kling", videoUrl(t)).href;
          },
          download: (url) => getBytes("Kling", deps.fetchCdn, plainHttpsUrl("Kling", url).href, {}, signal, MAX_CLIP_BYTES), // no key to the file host
          save: (bytes) => saveClip(bytes, { root: deps.root, provider: "kling_video", model: a.model, prompt: a.prompt, seconds: a.seconds, aspect: a.aspect, priceMicroUsd: reserve }),
        });
        return { result, actualMicroUsd: reserve };
      });
    },
  };
}
