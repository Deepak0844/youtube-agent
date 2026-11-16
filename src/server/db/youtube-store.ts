import type pg from "pg";
import type { Keyring } from "@/server/core/vault-crypto";
import type { QuotaCall } from "@/server/core/youtube-oauth";
import type { YouTubeStore } from "@/server/providers/uploader/youtube";
import { deleteSecret, putSecret } from "./vault";
import { getAccessToken, reserveQuota } from "./youtube-channels";

/** What the YouTube uploader needs from the database (tokens, quota, the upload session secret, the upload log), as one injected object. */
export const youtubeStore = (pool: pg.Pool, ring: Keyring | (() => Keyring)): YouTubeStore => ({
  accessToken: (http, channelRowId) => getAccessToken(pool, ring, http, channelRowId),
  reserveQuota: (call: QuotaCall) => reserveQuota(pool, call),
  putSecret: (name, plain, opts) => putSecret(pool, typeof ring === "function" ? ring() : ring, name, plain, opts),
  deleteSecret: (name) => deleteSecret(pool, name),
  // Rejects when the insert fails: the caller decides what that means (the title row must exist before the upload goes on).
  logUpload: async (uploadId, event) => {
    await pool.query("insert into upload_log (upload_id, event) values ($1, $2)", [uploadId, event]);
  },
});
