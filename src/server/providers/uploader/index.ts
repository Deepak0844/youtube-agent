import type { Readable } from "node:stream";
import type { UploadOutcome } from "@/server/db/uploads";

/** What the upload job verified at job time: the uploader sends exactly this file and nothing else. */
export interface UploadTarget {
  videoId: string;
  /** Storage-relative path of the approved video version; the bytes were hashed and matched `fileSha256` just before the start. */
  filePath: string;
  fileSha256: string;
  bytes: number;
  channelId: string;
  visibility: "private" | "unlisted" | "public";
  publishAt: string | null;
  /**
   * The ONLY way to read the approved file. The stream hashes what it delivers and errors at the end if the digest or length
   * differs from `fileSha256` / `bytes` (the file was swapped after the job-time check). An uploader must treat that error as
   * a failed upload and, if bytes already left, as "check YouTube Studio first". It must never open `filePath` itself.
   */
  open(): Promise<Readable>;
}

// One-shot upload of an approved file. Same shape the upload job already takes (db/upload-job.ts); `target` is added
// by the publish job (worker/stages/publish-upload.ts). A fake may ignore it; a real uploader (Phase 5) must use it.
export interface Uploader {
  upload(uploadId: string, onProgress: (bytesSent: number) => Promise<void>, signal: AbortSignal, target?: UploadTarget): Promise<UploadOutcome>;
}
export type { UploadOutcome };
