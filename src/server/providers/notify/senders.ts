import { execFile } from "node:child_process";
import type { ChannelPort } from "@/server/db/notify";
import { checkWebhookUrl, osascriptArgs } from "@/server/core/notify-send";
import { safeFetch } from "@/server/providers/net/safe-fetch";

type ExecFile = (file: string, args: string[], cb: (err: Error | null) => void) => unknown;

/** Desktop popup through osascript (macOS only). execFile with an argument list: no shell, nothing spliced into script source. Other systems: a quiet no-op. */
export function createDesktopPort(opts: { platform?: string; exec?: ExecFile } = {}): ChannelPort {
  const platform = opts.platform ?? process.platform;
  const exec: ExecFile = opts.exec ?? ((f, a, cb) => execFile(f, a, { timeout: 4000 }, (e) => cb(e)));
  return {
    send: (msg) =>
      platform !== "darwin"
        ? Promise.resolve()
        : new Promise<void>((resolve, reject) => exec("osascript", osascriptArgs(msg.title, msg.text), (err) => (err ? reject(err) : resolve()))),
  };
}

/** POST {title,text,message} as JSON. safeFetch in indirect mode refuses private, loopback and metadata addresses (also after DNS) and does not follow redirects. */
export function createWebhookPort(url: string, sf: typeof safeFetch = safeFetch): ChannelPort {
  return {
    async send(msg) {
      if (checkWebhookUrl(url) !== null) throw new RangeError("webhook address refused");
      const res = await sf(
        url,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: msg.title, text: msg.text, message: msg.message }) },
        { mode: "indirect", maxRedirects: 0, timeoutMs: 4000 },
      );
      await res.body?.cancel().catch(() => {});
      if (!res.ok) throw new Error(`webhook status ${res.status}`);
    },
  };
}
