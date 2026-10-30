import { quote as priceQuote, type PriceRule } from "@/server/core/media-catalog";
import { KnownFailure } from "@/server/core/paid-call";
import { sniff, SNIFF_HEAD_BYTES } from "@/server/core/sniff";
import type { ImageProvider } from "../media";
import type { SafeFetch } from "../voice/eleven-types";
import { postJson, readCapped } from "../voice/elevenlabs";
import { checkImage, refsOf, paidImage } from "./index";

export interface GeminiImageDeps {
  fetch: SafeFetch;
  /** Decrypted per call; never cached or logged. */
  getKey: () => Promise<string>;
  /** The `gemini_image` registry price; null = unpriced, refused. */
  price: PriceRule | null;
  budgetScopes: string[];
  /** Asset id to its file bytes (the caller reads the assets table). */
  readRef: (assetId: string) => Promise<Buffer>;
}

const HOST = "https://generativelanguage.googleapis.com";
// Gemini 3.1 Flash Lite Image: 1K only. The older gemini-2.5-flash-image is deprecated (shut down 2027-03-15), so it is not offered.
const MODELS: ReadonlySet<string> = new Set(["gemini-3.1-flash-lite-image"]);
const MAX_REF_BYTES = 10 * 1024 * 1024;
const REF_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);

export function createGeminiImage(deps: GeminiImageDeps): ImageProvider {
  const capability: ImageProvider["capability"] = { id: "gemini_image", refImages: true, seed: false, aspects: ["9:16", "16:9", "1:1"], maxRefs: 3 };
  const check = (a: { prompt?: string; aspect: string; refs?: string[]; seed?: number; model: string }) => {
    if (!MODELS.has(a.model)) throw new KnownFailure(`Gemini image model "${a.model.slice(0, 60)}" is not supported.`);
    return checkImage(capability, deps.price, { prompt: a.prompt ?? "x", aspect: a.aspect, refs: a.refs, seed: a.seed });
  };
  const quote: ImageProvider["quote"] = (a) => {
    check({ ...a, refs: refsOf(a.refs) });
    // DELIBERATE OVER-QUOTE: the per-image price covers the image output only. Input tokens (prompt, reference images) and any returned
    // text are billed on top, at rates not read from the page, so quote +10% plus +5% per reference image. Task 20 smoke refines this.
    return priceQuote(deps.price as PriceRule, 1.1 + 0.05 * a.refs);
  };
  return {
    capability,
    quote,
    async generate(ctx, a) {
      const prompt = check(a);
      const reserve = quote({ aspect: a.aspect, refs: a.refs?.length ?? 0, model: a.model });
      const refs: Array<{ type: "image"; mime_type: string; data: string }> = [];
      for (const id of a.refs ?? []) { // read and checked before anything is reserved
        const bytes = await deps.readRef(id).catch(() => { throw new KnownFailure("A reference image could not be read."); });
        const s = sniff(bytes.subarray(0, SNIFF_HEAD_BYTES));
        if (!("kind" in s) || s.kind !== "image" || !REF_MIME.has(s.mime) || bytes.length > MAX_REF_BYTES) throw new KnownFailure("A reference image must be a PNG, JPEG or WebP under 10 MB.");
        refs.push({ type: "image", mime_type: s.mime, data: bytes.toString("base64") });
      }
      const body = { model: a.model, input: [{ type: "text", text: prompt }, ...refs], response_format: { type: "image", aspect_ratio: a.aspect, image_size: "1K" } };
      return paidImage(ctx, { who: "Gemini", getKey: deps.getKey, budgetScopes: [...deps.budgetScopes, ...(a.budgetScopes ?? [])] }, reserve, async (key, signal) => {
        const res = await postJson("Gemini", deps.fetch, `${HOST}/v1beta/interactions`, { "x-goog-api-key": key }, body, signal);
        let json: { output_image?: { data?: unknown }; steps?: Array<{ content?: Array<{ type?: unknown; data?: unknown }> }> };
        try {
          json = JSON.parse((await readCapped(res, "Gemini")).toString("utf8"));
        } catch (err) {
          if (signal.aborted) throw signal.reason;
          throw new Error(err instanceof SyntaxError ? "Gemini returned an unreadable answer." : "Gemini's answer was cut off.");
        }
        const data = json.output_image?.data ?? json.steps?.flatMap((s) => s.content ?? []).find((c) => c.type === "image")?.data;
        if (typeof data !== "string" || data === "") throw new Error("Gemini returned no image."); // a refusal may still bill: unknown, parks
        return Buffer.from(data, "base64");
      }, { provider: "gemini_image", model: a.model, prompt, refs: a.refs ?? [], aspect: a.aspect });
    },
  };
}
