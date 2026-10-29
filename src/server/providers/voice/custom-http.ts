import { createHash } from "node:crypto";
import path from "node:path";
import { NotProcessedError } from "@/server/core/error-class";
import { LANGS } from "@/server/core/lang";
import type { StageContext } from "@/server/core/stage-handler";
import { renderBodyTemplate } from "@/server/core/voice-template";
import { callServer, postJson, readJson, saveCapped, type Access } from "./local-http";
import type { TimingsKind, VoiceProvider } from "./index";

export interface CustomHttpCfg extends Access {
  url: string;
  bodyTemplate: string;
  responseKind: "audio" | "json_url";
  urlJsonPath?: string; // like data.files[0].href; default "url"
  listVoicesUrl?: string;
  wordTimings: Extract<TimingsKind, "aligned" | "estimated">;
}

function pick(json: unknown, jsonPath: string): unknown {
  let cur = json;
  for (const seg of jsonPath.match(/[^.[\]]+/g) ?? []) {
    if (cur === null || typeof cur !== "object" || !Object.hasOwn(cur, seg)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** Any server: owner-written JSON body template, optional key header. Free. Times come from the voice stage (align or estimate). */
export function createCustomHttpVoice(cfg: CustomHttpCfg): VoiceProvider & { listVoices?: () => Promise<string[]> } {
  const listUrl = cfg.listVoicesUrl;
  return {
    capability: { id: "custom-http", wordTimings: cfg.wordTimings, local: true, languages: [...LANGS], maxChars: 4096, formats: ["wav"] },
    quote: () => 0,
    async synthesise(ctx: StageContext, a) {
      const body = renderBodyTemplate(cfg.bodyTemplate, { text: a.text, voice: a.voice, lang: a.lang }); // throws before any request
      const audioPath = path.join(ctx.attemptDir, `voice-${createHash("sha256").update(`${a.lang}\0${a.voice}\0${a.text}`).digest("hex").slice(0, 12)}.wav`);
      await ctx.paid({ reserveMicroUsd: 0, budgetScopes: [], kind: "paid" }, async (_key, signal) => {
        const res = await postJson(cfg.url, body, cfg, signal);
        if (cfg.responseKind === "audio") await saveCapped(res, audioPath);
        else {
          const href = pick(await readJson(res), cfg.urlJsonPath ?? "url");
          if (typeof href !== "string") throw new Error("The voice server's answer did not contain an audio address.");
          // Same server: already allowed. Anything else the server names must be a public https address.
          let to: URL;
          try { to = new URL(href); } catch { throw new NotProcessedError("The voice server named an audio address that is not a valid URL."); }
          const same = to.origin === new URL(cfg.url).origin;
          if (!same && to.protocol !== "https:") throw new NotProcessedError("The voice server named an audio address that is not https.");
          await saveCapped(await callServer(to.href, { method: "GET" }, cfg, signal, { withKey: false, indirect: !same }), audioPath);
        }
        return { result: null, actualMicroUsd: 0 };
      });
      return { audioPath, wordTimings: null, timingsKind: cfg.wordTimings, priceMicroUsd: 0, quoted: true };
    },
    ...(listUrl && {
      async listVoices() {
        if (new URL(listUrl).origin !== new URL(cfg.url).origin) throw new NotProcessedError("The voice list address must be on the same server as the voice address.");
        const json = await readJson(await callServer(listUrl, { method: "GET" }, cfg, AbortSignal.timeout(30_000)));
        const items = Array.isArray(json) ? json : (json as { voices?: unknown })?.voices;
        if (!Array.isArray(items)) throw new Error("The voice list was not in a form this app understands.");
        return items.map((v: unknown) => (typeof v === "string" ? v : String((v as { id?: unknown; name?: unknown })?.id ?? (v as { name?: unknown })?.name ?? ""))).filter(Boolean);
      },
    }),
  };
}
