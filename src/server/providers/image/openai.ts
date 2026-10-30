import { quote as priceQuote, type PriceRule } from "@/server/core/media-catalog";
import { KnownFailure } from "@/server/core/paid-call";
import type { Aspect, ImageProvider } from "../media";
import type { SafeFetch } from "../voice/eleven-types";
import { postJson, readCapped } from "../voice/elevenlabs";
import { checkImage, refsOf, scopesOf, paidImage } from "./index";

export interface OpenAIImageDeps {
  fetch: SafeFetch;
  /** Decrypted per call; never cached or logged. */
  getKey: () => Promise<string>;
  /** The `openai_image` registry price; null = unpriced, refused. */
  price: PriceRule | null;
  /** Absolute storage root; images are kept under generated-media/. */
  root: string;
}

const HOST = "https://api.openai.com";
// ONE model, lowest quality tier, PNG: the single per-image price rule must be set for exactly this tier at the LARGEST size below
// (1024x1536 and 1536x1024 cost the same; 1024x1024 costs less). Per-token pricing has no per-image page figure, so it stays unpriced until the owner records one.
const MODEL = "gpt-image-1-mini";
const QUALITY = "low";
const SIZE: Record<Aspect, string> = { "9:16": "1024x1536", "16:9": "1536x1024", "1:1": "1024x1024" };

export function createOpenAIImage(deps: OpenAIImageDeps): ImageProvider {
  // No reference images: they need the multipart edits endpoint, which is not built.
  const capability: ImageProvider["capability"] = { id: "openai_image", refImages: false, seed: false, aspects: ["9:16", "16:9", "1:1"], maxRefs: 0 };
  const check = (a: { prompt?: string; aspect: string; refs?: string[]; seed?: number; model: string }) => {
    if (a.model !== MODEL) throw new KnownFailure(`OpenAI image model "${a.model.slice(0, 60)}" is not supported.`);
    return checkImage(capability, deps.price, { prompt: a.prompt ?? "x", aspect: a.aspect, refs: a.refs, seed: a.seed });
  };
  const quote: ImageProvider["quote"] = (a) => {
    check({ ...a, refs: refsOf(a.refs) });
    return priceQuote(deps.price as PriceRule, 1);
  };
  return {
    capability,
    quote,
    async generate(ctx, a) {
      const prompt = check(a);
      const scopes = scopesOf(a.budgetScopes);
      const reserve = quote({ aspect: a.aspect, refs: a.refs?.length ?? 0, model: a.model });
      return paidImage(ctx, { who: "OpenAI", root: deps.root, getKey: deps.getKey, budgetScopes: scopes }, reserve, async (key, signal) => {
        // A moderation refusal is not documented as free, so it is treated as unknown (the reservation stays pending).
        const res = await postJson("OpenAI", deps.fetch, `${HOST}/v1/images/generations`, { authorization: `Bearer ${key}` }, { model: a.model, prompt, size: SIZE[a.aspect], n: 1, quality: QUALITY, output_format: "png" }, signal, (_s, t) => /moderation_blocked|safety/i.test(t));
        let b64: unknown;
        try {
          b64 = (JSON.parse((await readCapped(res, "OpenAI")).toString("utf8")) as { data?: Array<{ b64_json?: unknown }> }).data?.[0]?.b64_json;
        } catch (err) {
          if (signal.aborted) throw signal.reason;
          throw new Error(err instanceof SyntaxError ? "OpenAI returned an unreadable answer." : "OpenAI's answer was cut off.");
        }
        if (typeof b64 !== "string" || b64 === "") throw new Error("OpenAI returned no image.");
        return Buffer.from(b64, "base64");
      }, { provider: "openai_image", model: a.model, prompt, refs: [], aspect: a.aspect });
    },
  };
}
