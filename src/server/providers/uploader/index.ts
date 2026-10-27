import type { UploadOutcome } from "@/server/db/uploads";

// One-shot upload of an approved file. Same shape the upload job already takes (db/upload-job.ts).
export interface Uploader {
  upload(uploadId: string, onProgress: (bytesSent: number) => Promise<void>, signal: AbortSignal): Promise<UploadOutcome>;
}
export type { UploadOutcome };
