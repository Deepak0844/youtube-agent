import { Worker } from "node:worker_threads";
import { sha256Hex } from "@/server/core/content-hash";
import { S3K_ALLOWED, THREE_ALLOWED } from "@/server/core/scene3d-code-check";
import { S3K_API_DTS } from "@/server/core/s3k-kit-dts";

// Type-check of ONE AI-written 3D scene against the kit's declarations (layer 2 of the controls on AI-written code). The compiler runs in a
// WORKER THREAD (scene3d-typecheck.mjs: in-memory files, no emit, only the five allowed modules resolve, no Node types), so a pathological
// type can never block the worker's event loop. The thread gets the 15 s budget (a cancellation token the compiler polls) plus a 5 s grace;
// after that it is terminated. A timeout, a crash, a thread that exits or an unreadable answer is FATAL (`fatal: true`), never a hint for the
// model. The result carries the sha256 of the exact text that was checked so callers can confirm it is the text they will use.

export const SCENE_TYPECHECK_BUDGET_MS = 15_000;
export const SCENE_TYPECHECK_GRACE_MS = 5_000;
const THREAD = new URL("./scene3d-typecheck-thread.mjs", import.meta.url);
const HEAP_MB = 1024;

export interface SceneTypeResult {
  ok: boolean;
  problems: string[];
  /** sha256 of the exact source text that was checked: the host compares it with the bytes it is about to use. */
  sha256: string;
  /** true when the check itself could not finish (timeout, crash, unreadable answer): never a hint for the model, always a stop. */
  fatal?: boolean;
}

/** Type-checks one scene source. Never throws and never rejects. `budgetMs` and `graceMs` are for tests. */
export function typeCheckScene3d(source: string, budgetMs: number = SCENE_TYPECHECK_BUDGET_MS, graceMs: number = SCENE_TYPECHECK_GRACE_MS): Promise<SceneTypeResult> {
  const sha256 = sha256Hex(source);
  return new Promise((resolve) => {
    let settled = false;
    let w: Worker | undefined;
    const done = (r: SceneTypeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void w?.terminate().catch(() => undefined);
      resolve(r);
    };
    const stop = (why: string) => done({ ok: false, fatal: true, sha256, problems: [`type-check: ${why}`] });
    const timer = setTimeout(() => stop(`the type-check took longer than ${Math.round((budgetMs + graceMs) / 1000)} s and was stopped; write simpler, smaller code.`), budgetMs + graceMs);
    try {
      w = new Worker(THREAD, {
        workerData: { kind: "scene3d-typecheck", source, dts: S3K_API_DTS, pools: { s3k: S3K_ALLOWED, three: THREE_ALLOWED }, budgetMs },
        resourceLimits: { maxOldGenerationSizeMb: HEAP_MB },
        stdout: true,
        stderr: true,
      });
    } catch {
      return stop("the type-checker could not start.");
    }
    w.once("message", (m: unknown) => {
      const r = m as Partial<SceneTypeResult>;
      const valid = typeof r?.ok === "boolean" && Array.isArray(r.problems) && r.problems.every((p) => typeof p === "string") && r.sha256 === sha256;
      if (!valid) return stop("the type-checker gave an unreadable answer.");
      done({ ok: r.ok!, problems: r.problems!.slice(0, 12), sha256, ...(r.fatal ? { fatal: true } : {}) });
    });
    w.once("error", () => stop("the type-checker failed on this file."));
    w.once("exit", () => stop("the type-checker stopped without an answer."));
  });
}
