import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeKeyring } from "@/server/core/vault-crypto";
import { GOOGLE_SCOPES, quotaDay } from "@/server/core/youtube-oauth";
import { saveOwnGoogleApp } from "@/server/db/google-app";
import { getSecret, hasSecret } from "@/server/db/vault";
import { FILE_CHANGED_MESSAGE, StoredFileError } from "@/server/storage/hash-file";
import { completeConnect, confirmChannel, listAccounts, startConnect, type GoogleHttp } from "@/server/db/youtube-channels";
import type { UploadTarget } from "@/server/providers/uploader";
import { createYouTubeUploader, sessionSecretName } from "@/server/providers/uploader/youtube";
import { withTestDb, type TestDb } from "../support/db";
import { waitFor } from "./helpers/stage-env";

let db: TestDb;
const ring = makeKeyring(randomBytes(32).toString("base64"));
const SESSION = "11111111-1111-4111-8111-111111111111";
const APP_URL = "http://localhost:3000";
const UPLOAD = "0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
const SESSION_URI = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=SECRET-SESSION-ID";
const ACCESS = "ya29.SECRET-ACCESS-TOKEN";
const BYTES = Buffer.from("0123456789"); // 10 bytes: with chunkBytes 4 that is two chunks of 4 and a final of 2

const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });

interface Call { url: string; method: string; headers: Record<string, string>; body: string }
interface Server {
  calls: Call[];
  init?: () => Response;
  chunk?: (n: number, range: string) => Response;
  list?: () => Response;
  throwOnChunk?: number;
  http: GoogleHttp;
}
// A fake Google. Nothing here touches the network.
function server(o: Partial<Pick<Server, "init" | "chunk" | "list" | "throwOnChunk">> = {}): Server {
  const s: Server = { calls: [], ...o, http: async () => reply({}) };
  let chunks = 0;
  s.http = async (url, init) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    s.calls.push({ url, method: init?.method ?? "GET", headers, body: init?.body === undefined ? "" : Buffer.from(init.body as Buffer).toString("utf8") });
    if (url.includes("oauth2.googleapis.com/token")) return reply({ access_token: ACCESS, refresh_token: "r", scope: GOOGLE_SCOPES.join(" ") });
    if (url.includes("userinfo")) return reply({ sub: "sub-1", email: "me@example.com" });
    if (url.includes("/youtube/v3/channels")) return reply({ items: [{ id: "UCchan1", snippet: { title: "My Channel" } }] });
    if (url.includes("&part=snippet")) return s.init ? s.init() : reply({}, 200, { location: SESSION_URI });
    if (url.includes("upload_id=")) {
      chunks++;
      if (s.throwOnChunk === chunks) throw new TypeError("socket hang up");
      const range = headers["content-range"]!;
      const end = Number(/-(\d+)\//.exec(range)![1]);
      const total = Number(/\/(\d+)$/.exec(range)![1]);
      if (s.chunk) return s.chunk(chunks, range);
      return end + 1 === total ? reply({ id: "vid123" }, 200) : reply("", 308, { range: `bytes=0-${end}` });
    }
    if (url.includes("/youtube/v3/videos?part=status")) return s.list ? s.list() : reply({ items: [{ status: { privacyStatus: "private" } }] });
    throw new Error(`unexpected url ${url}`);
  };
  return s;
}
const insertCalls = (s: Server) => s.calls.filter((c) => c.url.includes("&part=snippet"));
const putCalls = (s: Server) => s.calls.filter((c) => c.method === "PUT");

let rowId: string;
beforeAll(async () => {
  db = await withTestDb();
});
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  await db.ownerPool.query("truncate google_accounts, youtube_channels, oauth_states, quota_usage, google_apps, secrets, audit_log, upload_log cascade");
  await saveOwnGoogleApp(db.pool, ring, { clientId: "123456789012-abcdefghijklmnopqrstuv12.apps.googleusercontent.com", clientSecret: "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1" });
  const st = await startConnect(db.pool, { sessionId: SESSION, appUrl: APP_URL });
  if (!st.ok) throw new Error(st.reason);
  await completeConnect(db.pool, ring, server().http, { sessionId: SESSION, state: new URL(st.url).searchParams.get("state")!, code: "c", appUrl: APP_URL });
  rowId = (await listAccounts(db.pool))[0]!.channels[0]!.id;
  await confirmChannel(db.pool, rowId, SESSION);
  await db.ownerPool.query("truncate quota_usage");
});

function target(o: { visibility?: "private" | "unlisted" | "public"; publishAt?: string | null; stream?: () => Readable; bytes?: number } = {}): UploadTarget {
  return {
    videoId: "v", filePath: "x.mp4", fileSha256: "0".repeat(64), bytes: o.bytes ?? BYTES.length, channelId: "UCchan1", channelRowId: rowId,
    details: { title: "My title", description: "desc", tags: ["a", "b"], categoryId: 27, language: "en", madeForKids: false, synthetic: true },
    visibility: o.visibility ?? "private", publishAt: o.publishAt ?? null, preFinal: async () => null,
    open: async () => (o.stream ? o.stream() : Readable.from([BYTES.subarray(0, 3), BYTES.subarray(3, 9), BYTES.subarray(9)])),
  };
}
const uploader = (s: Server) => createYouTubeUploader({ pool: db.pool, ring, http: s.http, chunkBytes: 4 });
const progress = () => {
  const seen: number[] = [];
  return { seen, fn: async (n: number) => void seen.push(n) };
};
const go = (s: Server, t: UploadTarget, p = progress()) => uploader(s).upload(UPLOAD, p.fn, new AbortController().signal, t);
const logOf = async () => (await db.ownerPool.query("select event from upload_log where upload_id = $1 order by id", [UPLOAD])).rows.map((r: { event: string }) => r.event);

describe("youtube uploader", () => {
  it("uploads in chunks, sends the approved fields, stores the session in the vault, reads the privacy back", async () => {
    const s = server();
    const p = progress();
    const out = await go(s, target({ visibility: "private", publishAt: "2030-01-01T10:00:00Z" }), p);
    expect(out).toEqual({ kind: "uploaded", youtubeId: "vid123" });
    const init = insertCalls(s)[0]!;
    expect(init.headers.authorization).toBe(`Bearer ${ACCESS}`);
    expect(init.headers["x-upload-content-length"]).toBe("10");
    expect(JSON.parse(init.body)).toEqual({
      snippet: { title: "My title", description: "desc", tags: ["a", "b"], categoryId: "27", defaultLanguage: "en" },
      status: { privacyStatus: "private", selfDeclaredMadeForKids: false, containsSyntheticMedia: true, publishAt: "2030-01-01T10:00:00.000Z" },
    });
    expect(putCalls(s).map((c) => [c.headers["content-range"], c.body])).toEqual([["bytes 0-3/10", "0123"], ["bytes 4-7/10", "4567"], ["bytes 8-9/10", "89"]]);
    expect(p.seen[0]).toBe(1);
    expect(p.seen.at(-1)).toBe(10);
    expect(await hasSecret(db.pool, sessionSecretName(UPLOAD))).toBe(false); // a clear end deletes the session address
    expect(await logOf()).toEqual(["sent_title: My title", "readback_ok: private"]);
    // insert (1600) + read-back (1) are reserved before their calls
    expect(Number((await db.ownerPool.query("select units from quota_usage where day = $1", [quotaDay(new Date())])).rows[0].units)).toBe(1601);
  });

  it("sends no publishAt unless the video is private and scheduled", async () => {
    const s = server();
    await go(s, target({ visibility: "unlisted", publishAt: null }));
    expect(JSON.parse(insertCalls(s)[0]!.body).status).toEqual({ privacyStatus: "unlisted", selfDeclaredMadeForKids: false, containsSyntheticMedia: true });
  });

  it("a clear 4xx at the start is a failed outcome with a plain reason and nothing is sent", async () => {
    const s = server({ init: () => reply({ error: { errors: [{ reason: "quotaExceeded" }] } }, 403) });
    expect(await go(s, target())).toEqual({ kind: "failed", reason: "YouTube says the daily quota is used up" });
    expect(putCalls(s)).toHaveLength(0);
  });

  it("a 4xx on a chunk is a clear failed outcome", async () => {
    const s = server({ chunk: (n) => (n === 2 ? reply({ error: { errors: [{ reason: "invalidMetadata" }] } }, 400) : reply("", 308, { range: "bytes=0-3" })) });
    expect(await go(s, target())).toEqual({ kind: "failed", reason: "YouTube refused the title, description or tags" });
    expect(await hasSecret(db.pool, sessionSecretName(UPLOAD))).toBe(false);
  });

  it("a 5xx after bytes started throws (unclear) after reporting progress, and nothing is sent twice", async () => {
    const s = server({ chunk: (n) => (n === 2 ? reply("boom", 503) : reply("", 308, { range: "bytes=0-3" })) });
    const p = progress();
    await expect(go(s, target(), p)).rejects.toThrow(/did not confirm/);
    expect(await getSecret(db.pool, ring, sessionSecretName(UPLOAD))).toBe(SESSION_URI); // kept for the human check
    expect(p.seen[0]).toBe(1);
    expect(putCalls(s)).toHaveLength(2);
    expect(insertCalls(s)).toHaveLength(1);
  });

  it("a socket reset or timeout on the very first chunk is unclear too (progress was already reported)", async () => {
    const s = server({ throwOnChunk: 1 });
    const p = progress();
    await expect(go(s, target({ bytes: 3, stream: () => Readable.from([BYTES.subarray(0, 3)]) }), p)).rejects.toThrow(/did not confirm/);
    expect(p.seen).toEqual([1]);
    expect(putCalls(s)).toHaveLength(1);
  });

  it("a final answer with no video id is unclear, never success", async () => {
    const s = server({ chunk: (n, range) => (range.includes("8-9") ? reply({}, 200) : reply("", 308, { range: `bytes=0-${n * 4 - 1}` })) });
    await expect(go(s, target())).rejects.toThrow(/no video id/);
  });

  it("swapped file bytes fail the upload and the final chunk is never sent", async () => {
    const bad = () => new Readable({ read() { this.push(BYTES.subarray(0, 9)); this.destroy(new StoredFileError(FILE_CHANGED_MESSAGE)); } });
    const s = server();
    expect(await go(s, target({ stream: bad }))).toMatchObject({ kind: "failed", reason: expect.stringMatching(/changed after it was approved/) });
    expect(putCalls(s).every((c) => !c.headers["content-range"]!.endsWith("-9/10"))).toBe(true);
  });

  it("a read problem that is not a hash mismatch is not called 'file changed'", async () => {
    const slow = () => new Readable({ read() { this.push(BYTES.subarray(0, 9)); this.destroy(new StoredFileError("reading the file took too long")); } });
    const s = server();
    const out = await go(s, target({ stream: slow }));
    expect(out).toMatchObject({ kind: "failed", reason: expect.stringMatching(/could not be read/) });
    expect(JSON.stringify(out)).not.toMatch(/changed/);
    expect(putCalls(s).every((c) => !c.headers["content-range"]!.endsWith("-9/10"))).toBe(true);
  });

  it("any answer to the final PUT other than 200/201 is unclear, a 4xx included", async () => {
    const s = server({ chunk: (n, range) => (range.includes("8-9") ? reply({ error: { errors: [{ reason: "forbidden" }] } }, 403) : reply("", 308, { range: `bytes=0-${n * 4 - 1}` })) });
    await expect(go(s, target())).rejects.toThrow(/did not confirm/);
    expect(await hasSecret(db.pool, sessionSecretName(UPLOAD))).toBe(true);
  });

  it("stops before the final chunk when the recheck says no (clear failure, nothing finalised, session deleted)", async () => {
    const s = server();
    const t = { ...target(), preFinal: async () => "approval_changed" };
    expect(await go(s, t)).toMatchObject({ kind: "failed", reason: expect.stringMatching(/approval changed/) });
    expect(putCalls(s).every((c) => !c.headers["content-range"]!.endsWith("-9/10"))).toBe(true);
    expect(await hasSecret(db.pool, sessionSecretName(UPLOAD))).toBe(false);
  });

  it("keeps reporting progress while a request is in flight (a long final PUT is not a stall)", async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const s = server();
    const base = s.http;
    s.http = async (url, init) => {
      if (init?.method === "PUT" && (init.headers as Record<string, string>)["content-range"]?.includes("8-9")) await hold;
      return base(url, init);
    };
    const p = progress();
    const pending = createYouTubeUploader({ pool: db.pool, ring, http: s.http, chunkBytes: 4, heartbeatMs: 10 }).upload(UPLOAD, p.fn, new AbortController().signal, target());
    await waitFor(async () => p.seen.length > 5, "heartbeats arrive while the final PUT is held");
    const during = p.seen.length;
    release();
    expect(await pending).toEqual({ kind: "uploaded", youtubeId: "vid123" });
    expect(during).toBeGreaterThan(4); // 1, 4, 8 and several heartbeats
  });

  it("a heartbeat tick during the read-back does not abort it", async () => {
    const s = server({ list: () => reply({ items: [{ status: { privacyStatus: "private" } }] }) });
    const base = s.http;
    s.http = async (url, init) => {
      if (url.includes("/youtube/v3/videos?part=status")) await new Promise((r) => setTimeout(r, 60)); // several ticks pass here
      return base(url, init);
    };
    const p = progress();
    const out = await createYouTubeUploader({ pool: db.pool, ring, http: s.http, chunkBytes: 4, heartbeatMs: 10 }).upload(UPLOAD, p.fn, new AbortController().signal, target());
    expect(out).toEqual({ kind: "uploaded", youtubeId: "vid123" });
    expect(await logOf()).toContain("readback_ok: private");
    // heartbeats never go backwards
    const nums = p.seen;
    expect(nums.every((n, i) => i === 0 || n >= nums[i - 1]!)).toBe(true);
  });

  it("refuses without quota: nothing is called at YouTube", async () => {
    await db.ownerPool.query("insert into quota_usage (day, units) values ($1, 7000)", [quotaDay(new Date())]);
    const s = server();
    expect(await go(s, target())).toMatchObject({ kind: "failed", reason: expect.stringMatching(/quota/) });
    expect(insertCalls(s)).toHaveLength(0);
  });

  it("records what YouTube kept when it is not what was approved (still a success: the video exists)", async () => {
    const s = server({ list: () => reply({ items: [{ status: { privacyStatus: "private" } }] }) });
    expect(await go(s, target({ visibility: "public" }))).toEqual({ kind: "uploaded", youtubeId: "vid123" });
    expect(await logOf()).toEqual(["sent_title: My title", "privacy_mismatch: approved=public reported=private"]);
  });

  it("a session address outside googleapis.com is refused and no bytes go there", async () => {
    const s = server({ init: () => reply({}, 200, { location: "https://evil.example/upload?id=1" }) });
    expect((await go(s, target())).kind).toBe("failed");
    expect(putCalls(s)).toHaveLength(0);
  });

  it("an unconfirmed channel never gets a token or a call", async () => {
    await db.ownerPool.query("update youtube_channels set status = 'unconfirmed'");
    const s = server();
    expect((await go(s, target())).kind).toBe("failed");
    expect(insertCalls(s)).toHaveLength(0);
  });

  it("the access token and session address never appear in errors, the upload log or the audit log", async () => {
    const s = server({ chunk: () => reply("boom", 500) });
    let msg = "";
    await go(s, target()).catch((e: Error) => void (msg = e.message));
    const dump = msg + JSON.stringify(await logOf()) + JSON.stringify((await db.ownerPool.query("select detail from audit_log")).rows);
    expect(dump).not.toContain("SECRET");
  });
});
