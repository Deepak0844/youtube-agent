import { sniff, SNIFF_HEAD_BYTES } from "@/server/core/sniff";
import { KnownFailure } from "@/server/core/paid-call";
import { clipProblem, quoteClip, type VideoModelCap } from "@/server/core/video-clip";
import type { Db } from "@/server/db/stages";
import { runAsyncMedia, stepOfKey } from "../async-media";
import type { JobChecker } from "../media-types";
import type { SafeFetch } from "../voice/eleven-types";
import { postJson, readCapped } from "../voice/elevenlabs";
import { getBytes, HttpStatusError, parseJson, plainHttpsUrl } from "./http";
import { clipScopes, MAX_CLIP_BYTES, saveClip, type ClipArgs, type VideoProvider } from "./index";
import { readKey } from "../image";

// Seedance through BytePlus ModelArk. Written from the public docs (create task: POST /contents/generations/tasks, Bearer key;
// retrieve: GET /contents/generations/tasks/{id}, status and content.video_url). NOT proven against the real service yet.
const BASE = "https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks";
const TASK_ID = /^[A-Za-z0-9_-]{8,100}$/;
const ASPECTS = ["9:16", "16:9", "1:1"] as const;
const cap = (id: string, maxSeconds: number): VideoModelCap => ({ id, imageToVideo: true, endFrame: true, audio: true, aspects: ASPECTS, minSeconds: 4, maxSeconds });

/** Model ids are ModelArk's own. Clip length limits are from its docs (2.5: 4 to 30 s; the others 4 to 15 s). */
export const SEEDANCE_MODELS: Readonly<Record<string, VideoModelCap>> = {
  "dreamina-seedance-2-5-260628": cap("dreamina-seedance-2-5-260628", 30),
  "dreamina-seedance-2-0-260128": cap("dreamina-seedance-2-0-260128", 15),
  "dreamina-seedance-2-0-fast-260128": cap("dreamina-seedance-2-0-fast-260128", 15),
  "dreamina-seedance-2-0-mini-260615": cap("dreamina-seedance-2-0-mini-260615", 15),
};

export interface SeedanceDeps {
  /** Typed host ark.ap-southeast.bytepluses.com. */
  fetch: SafeFetch;
  /** Indirect (public-address-only) fetch for the result file; it never gets the key. */
  fetchCdn: SafeFetch;
  db: Db;
  getKey: () => Promise<string>;
  /** The `seedance_video` registry price (per second). It must be the price for `resolution`; null = unpriced, refused. */
  price: unknown;
  root: string;
  /** Output size. The owner's per-second price has to match it: 720p unless changed. */
  resolution?: "480p" | "720p" | "1080p";
  /** The bytes of a start or end picture by storage-relative path (the reader keeps it inside the storage root). */
  readImage: (storagePath: string) => Promise<Buffer>;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** png / jpeg / webp only, as a data address the provider accepts. */
export function imageDataUrl(bytes: Buffer): string {
  const s = sniff(bytes.subarray(0, SNIFF_HEAD_BYTES));
  if (!("kind" in s) || s.kind !== "image" || !["image/png", "image/jpeg", "image/webp"].includes(s.mime)) throw new KnownFailure("A start or end picture must be a PNG, JPEG or WebP image.");
  return `data:${s.mime};base64,${bytes.toString("base64")}`;
}

type Task = { status?: unknown; content?: { video_url?: unknown }; error?: unknown };

/** Read-only look at a job we already submitted. Only a clear 404 or a "failed" status is `failed`; every other surprise is `unknown`, which keeps the money held. */
export function createSeedanceJobChecker(deps: Pick<SeedanceDeps, "fetch" | "fetchCdn" | "getKey" | "root">): JobChecker {
  return {
    async check(job) {
      if (!TASK_ID.test(job.providerJobId)) return { kind: "unknown" };
      const signal = AbortSignal.timeout(300_000);
      try {
        const auth = { authorization: `Bearer ${await readKey(deps.getKey, "Seedance")}` };
        let t: Task;
        try {
          t = parseJson<Task>("Seedance", await getBytes("Seedance", deps.fetch, `${BASE}/${job.providerJobId}`, auth, signal));
        } catch (err) {
          if (err instanceof HttpStatusError && err.status === 404) return { kind: "failed", reason: "Seedance has no record of this job." };
          throw err;
        }
        if (t.status === "queued" || t.status === "running") return { kind: "running" };
        if (t.status === "failed" || t.status === "cancelled" || t.status === "expired") return { kind: "failed", reason: "Seedance reports that the job did not finish." };
        if (t.status !== "succeeded") return { kind: "unknown" };
        const bytes = await getBytes("Seedance", deps.fetchCdn, plainHttpsUrl("Seedance", t.content?.video_url).href, {}, signal, MAX_CLIP_BYTES);
        return { kind: "done", artifact: await saveClip(bytes, { root: deps.root, provider: "seedance_video", model: "unknown", prompt: "", seconds: 0, aspect: "", priceMicroUsd: job.quoteMicroUsd }) };
      } catch {
        return { kind: "unknown" };
      }
    },
  };
}

export function createSeedanceVideo(deps: SeedanceDeps): VideoProvider {
  const resolution = deps.resolution ?? "720p";
  const check = (a: ClipArgs) => {
    const model = Object.hasOwn(SEEDANCE_MODELS, a.model) ? SEEDANCE_MODELS[a.model] : undefined;
    if (!model) throw new KnownFailure(`The Seedance model "${a.model.slice(0, 60)}" is not supported.`);
    const why = clipProblem(model, a);
    if (why) throw new KnownFailure(why);
    if (a.startImage !== (a.startImagePath !== undefined) || a.endImage !== (a.endImagePath !== undefined)) throw new KnownFailure("A picture was announced but not given, or given but not announced.");
    return quoteClip(deps.price, a.seconds);
  };

  return {
    capability: { id: "seedance_video", models: SEEDANCE_MODELS },
    quote: check,
    async generate(ctx, a) {
      const reserve = check(a);
      const scopes = clipScopes(a.budgetScopes);
      // Pictures are read BEFORE anything is reserved or submitted: a bad file is a plain refusal.
      const frames: Array<{ role: "first_frame" | "last_frame"; url: string }> = [];
      if (a.startImagePath) frames.push({ role: "first_frame", url: imageDataUrl(await deps.readImage(a.startImagePath)) });
      if (a.endImagePath) frames.push({ role: "last_frame", url: imageDataUrl(await deps.readImage(a.endImagePath)) });
      const body = {
        model: a.model,
        content: [{ type: "text", text: a.prompt }, ...frames.map((f) => ({ type: "image_url", role: f.role, image_url: { url: f.url } }))],
        resolution, ratio: a.aspect, duration: a.seconds,
        generate_audio: false, // voice and sound are made elsewhere
        watermark: false,
      };
      return ctx.paid({ reserveMicroUsd: reserve, budgetScopes: scopes, kind: "paid" }, async (callKey, signal) => {
        const auth = async () => ({ authorization: `Bearer ${await readKey(deps.getKey, "Seedance")}` });
        let flaky = 0; // status polls that failed in a row; the job id is stored, so a few are tolerated
        const result = await runAsyncMedia(ctx, { db: deps.db, provider: "seedance_video", kind: "video", step: stepOfKey(callKey), quoteMicroUsd: reserve, signal, sleep: deps.sleep }, {
          async submit() {
            const res = await postJson("Seedance", deps.fetch, BASE, await auth(), body, signal);
            const id = parseJson<{ id?: unknown }>("Seedance", await readCapped(res, "Seedance")).id;
            if (typeof id !== "string" || !TASK_ID.test(id)) throw new Error("Seedance returned no usable job id.");
            return id;
          },
          async poll(id) {
            let t: Task;
            try {
              t = parseJson<Task>("Seedance", await getBytes("Seedance", deps.fetch, `${BASE}/${id}`, await auth(), signal));
              flaky = 0;
            } catch (err) {
              if (signal.aborted || ++flaky > 3) throw err;
              return null;
            }
            if (t.status === "queued" || t.status === "running") return null;
            if (t.status === "failed" || t.status === "cancelled" || t.status === "expired") throw new Error("Seedance reported the job did not finish; the outcome is unknown.");
            if (t.status !== "succeeded") throw new Error("Seedance reported an unknown job state.");
            return plainHttpsUrl("Seedance", t.content?.video_url).href;
          },
          download: (url) => getBytes("Seedance", deps.fetchCdn, plainHttpsUrl("Seedance", url).href, {}, signal, MAX_CLIP_BYTES), // no key to the file host
          save: (bytes) => saveClip(bytes, { root: deps.root, provider: "seedance_video", model: a.model, prompt: a.prompt, seconds: a.seconds, aspect: a.aspect, priceMicroUsd: reserve }),
        });
        return { result, actualMicroUsd: reserve };
      });
    },
  };
}
