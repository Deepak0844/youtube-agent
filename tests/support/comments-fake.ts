import { randomBytes } from "node:crypto";
import { makeKeyring } from "@/server/core/vault-crypto";
import { GOOGLE_SCOPES } from "@/server/core/youtube-oauth";
import { saveOwnGoogleApp } from "@/server/db/google-app";
import { createVideoRow } from "@/server/db/videos";
import { completeConnect, confirmChannel, listAccounts, startConnect, type GoogleHttp } from "@/server/db/youtube-channels";
import type { TestDb } from "./db";

// A fake Google for the comment tests. NEVER the real network: every call is recorded in `calls`.
export const ring = makeKeyring(randomBytes(32).toString("base64"));
export const SESSION = "11111111-1111-4111-8111-111111111111";
export const YT = "abcDEF12345";
const APP_URL = "http://localhost:3000";

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export interface FakeThread { id: string; text: string; author?: string; authorChannelId?: string; publishedAt?: string }
export interface Fake {
  http: GoogleHttp;
  calls: Array<{ url: string; method: string; body?: string }>;
  threads: FakeThread[];
  /** what comments.insert does */
  insert: "ok" | "throw" | "500" | "403";
  listStatus: number;
  posts: () => Array<{ url: string; method: string; body?: string }>;
}

export function fakeGoogle(): Fake {
  const f: Fake = {
    calls: [], threads: [], insert: "ok", listStatus: 200,
    posts: () => f.calls.filter((c) => c.url.includes("/youtube/v3/comments")),
    http: async (url, init) => {
      f.calls.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined });
      if (url.includes("oauth2.googleapis.com/token")) return reply({ access_token: "at", refresh_token: "1//r", scope: GOOGLE_SCOPES.join(" ") });
      if (url.includes("userinfo")) return reply({ sub: "sub-1", email: "me@example.com" });
      if (url.includes("youtube/v3/channels")) return reply({ items: [{ id: "UCchan1", snippet: { title: "My Channel" } }] });
      if (url.includes("youtube/v3/commentThreads")) {
        if (f.listStatus !== 200) return reply({ error: "x" }, f.listStatus);
        return reply({
          items: f.threads.map((t) => ({
            snippet: { topLevelComment: { id: t.id, snippet: { textOriginal: t.text, authorDisplayName: t.author ?? "Viewer", publishedAt: t.publishedAt ?? "2026-11-01T10:00:00Z", ...(t.authorChannelId ? { authorChannelId: { value: t.authorChannelId } } : {}) } } },
          })),
        });
      }
      if (url.includes("youtube/v3/comments")) {
        if (f.insert === "throw") throw new Error("socket hang up");
        if (f.insert === "500") return reply({ error: "boom" }, 500);
        if (f.insert === "403") return reply({ error: "forbidden" }, 403);
        return reply({ id: "UgyPosted1" });
      }
      return reply({}, 404);
    },
  };
  return f;
}

/** Saves the Google app, connects the fake channel UCchan1 and optionally confirms it. Quota used by connecting is cleared. */
export async function connectChannel(db: TestDb, f: Fake, confirm: boolean): Promise<string> {
  await saveOwnGoogleApp(db.pool, ring, { clientId: "123456789012-abcdefghijklmnopqrstuv12.apps.googleusercontent.com", clientSecret: "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1" });
  const r = await startConnect(db.pool, { sessionId: SESSION, appUrl: APP_URL });
  if (!r.ok) throw new Error(r.reason);
  await completeConnect(db.pool, ring, f.http, { sessionId: SESSION, state: new URL(r.url).searchParams.get("state")!, code: "c", appUrl: APP_URL });
  const id = (await listAccounts(db.pool))[0]!.channels[0]!.id;
  if (confirm) await confirmChannel(db.pool, id, SESSION);
  f.calls.length = 0;
  await db.ownerPool.query("truncate quota_usage");
  return id;
}

export async function uploadedVideo(db: TestDb, topic = "why sky is blue"): Promise<string> {
  const v = await createVideoRow(db.pool, { format: "short", kind: "scene_kit", language: "en", topic, channelId: "UCchan1" });
  await db.ownerPool.query(
    "insert into uploads (id, video_id, status, channel_id, youtube_id, started_at, finished_at, attempt) values (gen_random_uuid(), $1, 'uploaded', 'UCchan1', $2, now(), now(), 1)",
    [v.id, YT],
  );
  return v.id;
}
