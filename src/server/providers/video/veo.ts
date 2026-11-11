import { KnownFailure } from "@/server/core/paid-call";
import { clipProblem, quoteClip, type VideoModelCap } from "@/server/core/video-clip";
import { sniff, SNIFF_HEAD_BYTES } from "@/server/core/sniff";
import type { Db } from "@/server/db/stages";
import { runAsyncMedia, stepOfKey } from "../async-media";
import { readKey } from "../image";
import type { JobChecker } from "../media-types";
import type { SafeFetch } from "../voice/eleven-types";
import { postJson, readCapped } from "../voice/elevenlabs";
import { fetchAccessToken, parseServiceAccount } from "./google-auth";
import { parseJson } from "./http";
import { clipScopes, MAX_CLIP_BYTES, saveClip, type ClipArgs, type VideoProvider } from "./index";

// Veo on Google Cloud (Vertex AI). Written from Google's public docs: POST .../publishers/google/models/MODEL:predictLongRunning, then POST
// .../MODEL:fetchPredictOperation { operationName }; the video comes back inline (no storage bucket is given). The field name `generateAudio`
// and the absence of an end-frame field are NOT confirmed by the REST page; NOT proven against the real service.
const LOCATION = "us-central1";
const API = `https://${LOCATION}-aiplatform.googleapis.com/v1`;
const OPERATION = /^projects\/[a-z][a-z0-9-]{4,60}\/locations\/[a-z0-9-]{3,30}\/publishers\/google\/models\/[A-Za-z0-9.-]{3,80}\/operations\/[A-Za-z0-9-]{8,80}$/;
const veo = (id: string): VideoModelCap => ({ id, imageToVideo: true, endFrame: false, audio: true, aspects: ["9:16", "16:9"], minSeconds: 4, maxSeconds: 8, allowedSeconds: [4, 6, 8] });

/** Each tier is its own model and price: standard, fast, and the preview lite tier. */
export const VEO_MODELS: Readonly<Record<string, VideoModelCap>> = {
  "veo-3.1-generate-001": veo("veo-3.1-generate-001"),
  "veo-3.1-fast-generate-001": veo("veo-3.1-fast-generate-001"),
  "veo-3.1-lite-generate-001": veo("veo-3.1-lite-generate-001"),
};

export interface VeoDeps {
  /** Typed hosts us-central1-aiplatform.googleapis.com and oauth2.googleapis.com. */
  fetch: SafeFetch;
  db: Db;
  /** The saved service-account JSON, decrypted per call; never cached or logged. */
  getKey: () => Promise<string>;
  /** The `veo_video` registry price (per second) for the model in use. null = unpriced, refused. */
  price: unknown;
  root: string;
  resolution?: "720p" | "1080p";
  readImage: (storagePath: string) => Promise<Buffer>;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

type Op = { done?: unknown; error?: unknown; response?: { videos?: Array<{ bytesBase64Encoded?: unknown; mimeType?: unknown }>; raiMediaFilteredCount?: unknown } };

/** jpeg or png only: this endpoint does not take webp. */
function pictureBody(bytes: Buffer): { bytesBase64Encoded: string; mimeType: string } {
  const s = sniff(bytes.subarray(0, SNIFF_HEAD_BYTES));
  if (!("kind" in s) || s.kind !== "image" || !["image/png", "image/jpeg"].includes(s.mime)) throw new KnownFailure("A Veo start picture must be a PNG or JPEG image.");
  return { bytesBase64Encoded: bytes.toString("base64"), mimeType: s.mime };
}

/** The video bytes of a finished operation, or null while running. An error or an empty answer is an unknown outcome (it may have billed). */
function videoOf(who: string, op: Op): Buffer | null {
  if (op.done !== true) return null;
  if (op.error) throw new Error(`${who} reported the job failed; the outcome is unknown.`);
  const b64 = op.response?.videos?.[0]?.bytesBase64Encoded;
  if (typeof b64 !== "string" || b64 === "") throw new Error(`${who} finished without a video (it may have been filtered); the outcome is unknown.`);
  return Buffer.from(b64, "base64");
}

async function fetchOperation(deps: Pick<VeoDeps, "fetch">, token: string, name: string, signal: AbortSignal): Promise<Op> {
  const url = `${API}/${name.split("/operations/")[0]}:fetchPredictOperation`;
  const res = await postJson("Veo", deps.fetch, url, { authorization: `Bearer ${token}` }, { operationName: name }, signal, () => true); // after the submit every refusal is unknown
  return parseJson<Op>("Veo", await readCapped(res, "Veo", MAX_CLIP_BYTES * 2)); // base64 is a third bigger than the file
}

export function createVeoJobChecker(deps: Pick<VeoDeps, "fetch" | "getKey" | "root" | "now">): JobChecker {
  return {
    async check(job) {
      if (!OPERATION.test(job.providerJobId)) return { kind: "unknown" };
      const signal = AbortSignal.timeout(300_000);
      try {
        const sa = parseServiceAccount(await readKey(deps.getKey, "Google Cloud"));
        const token = await fetchAccessToken(deps.fetch, sa, Math.floor((deps.now ?? Date.now)() / 1000), signal);
        const op = await fetchOperation(deps, token, job.providerJobId, signal);
        if (op.done !== true) return { kind: "running" };
        if (op.error) return { kind: "failed", reason: "Google reports that the job failed." };
        const bytes = videoOf("Veo", op);
        if (!bytes) return { kind: "unknown" };
        return { kind: "done", artifact: await saveClip(bytes, { root: deps.root, provider: "veo_video", model: "unknown", prompt: "", seconds: 0, aspect: "", priceMicroUsd: job.quoteMicroUsd }) };
      } catch {
        return { kind: "unknown" };
      }
    },
  };
}

export function createVeoVideo(deps: VeoDeps): VideoProvider {
  const resolution = deps.resolution ?? "720p";
  const check = (a: ClipArgs) => {
    const model = Object.hasOwn(VEO_MODELS, a.model) ? VEO_MODELS[a.model] : undefined;
    if (!model) throw new KnownFailure(`The Veo model "${a.model.slice(0, 60)}" is not supported.`);
    const why = clipProblem(model, a);
    if (why) throw new KnownFailure(why);
    if (a.startImage !== (a.startImagePath !== undefined)) throw new KnownFailure("A picture was announced but not given, or given but not announced.");
    return quoteClip(deps.price, a.seconds);
  };

  return {
    capability: { id: "veo_video", models: VEO_MODELS },
    quote: check,
    async generate(ctx, a) {
      const reserve = check(a);
      const scopes = clipScopes(a.budgetScopes);
      const picture = a.startImagePath ? pictureBody(await deps.readImage(a.startImagePath)) : undefined; // read BEFORE anything is reserved
      const instance = { prompt: a.prompt, ...(picture && { image: picture }) };
      const parameters = { aspectRatio: a.aspect, durationSeconds: a.seconds, resolution, sampleCount: 1, generateAudio: false };
      return ctx.paid({ reserveMicroUsd: reserve, budgetScopes: scopes, kind: "paid" }, async (callKey, signal) => {
        const now = deps.now ?? Date.now;
        const sa = parseServiceAccount(await readKey(deps.getKey, "Google Cloud")); // a bad file refuses here, before any submit
        let token = await fetchAccessToken(deps.fetch, sa, Math.floor(now() / 1000), signal);
        let tokenAt = now();
        const bearer = async () => {
          if (now() - tokenAt > 45 * 60_000) { // tokens last an hour; renew before a long wait runs it out
            token = await fetchAccessToken(deps.fetch, sa, Math.floor(now() / 1000), signal);
            tokenAt = now();
          }
          return token;
        };
        let flaky = 0;
        let held: Buffer | null = null;
        const result = await runAsyncMedia(ctx, { db: deps.db, provider: "veo_video", kind: "video", step: stepOfKey(callKey), quoteMicroUsd: reserve, signal, sleep: deps.sleep }, {
          async submit() {
            const url = `${API}/projects/${sa.project_id}/locations/${LOCATION}/publishers/google/models/${a.model}:predictLongRunning`;
            const res = await postJson("Veo", deps.fetch, url, { authorization: `Bearer ${await bearer()}` }, { instances: [instance], parameters }, signal);
            const name = parseJson<{ name?: unknown }>("Veo", await readCapped(res, "Veo")).name;
            if (typeof name !== "string" || !OPERATION.test(name) || !name.includes(`/models/${a.model}/operations/`)) throw new Error("Veo returned no usable job name.");
            return name;
          },
          async poll(name) {
            let op: Op;
            try {
              op = await fetchOperation(deps, await bearer(), name, signal);
              flaky = 0;
            } catch (err) {
              if (signal.aborted || ++flaky > 3) throw err;
              return null;
            }
            held = videoOf("Veo", op); // a reported failure or an empty answer parks at once
            return held ? "inline" : null;
          },
          download: async () => held!, // the bytes came with the finished operation
          save: (bytes) => saveClip(bytes, { root: deps.root, provider: "veo_video", model: a.model, prompt: a.prompt, seconds: a.seconds, aspect: a.aspect, priceMicroUsd: reserve }),
        });
        return { result, actualMicroUsd: reserve };
      });
    },
  };
}
