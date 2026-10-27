import { KnownFailure } from "@/server/core/paid-call";
import { createScript, type FakeCounters, type FakeOptions } from "../fake-base";
import type { Uploader } from "./index";

const TOTAL = 1_000_000;

// Reports progress in four steps, then returns "uploaded" with a fake id. A scripted known failure becomes a
// "failed" outcome (what a real uploader returns for a clear rejection); an unknown failure throws.
export function createFakeUploader(opts: FakeOptions = {}): Uploader & FakeCounters {
  const s = createScript(opts);
  return {
    calls: s.calls,
    totalCalls: s.totalCalls,
    dbCalls: s.dbCalls,
    async upload(uploadId, onProgress, signal) {
      try {
        await s.play(`fake:upload:${uploadId}`, signal, { actualMicroUsd: 0 });
      } catch (err) {
        if (err instanceof KnownFailure) return { kind: "failed", reason: err.message };
        throw err;
      }
      for (const f of [0.25, 0.5, 0.75, 1]) {
        if (signal.aborted) throw signal.reason;
        await onProgress(Math.round(TOTAL * f));
      }
      return { kind: "uploaded", youtubeId: `fake-${uploadId}` };
    },
  };
}
