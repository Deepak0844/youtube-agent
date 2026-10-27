import { compactLine, redactLine } from "@/server/core/log-redact";
import type { StageLogHandle } from "@/server/core/stage-handler";
import { emitEvent, type WakeBus } from "@/server/db/events";
import type { Db } from "@/server/db/stages";
import { createLogSink, stageLogPath, type LogIo } from "./log-sink";

// What ctx.log writes to: redacted and compacted lines go to the capped file, and a batched copy (at most one `log`
// event per second per run) goes to the live feed. Nothing here may throw into the stage.
export interface StageLogDeps {
  db: Db;
  bus?: WakeBus;
  storageRoot: string;
  capBytes: number;
  io?: LogIo;
  flushMs?: number;
  /** Log events wait for this (the stage.started insert), so the feed shows started before the first log batch. */
  after?: Promise<unknown>;
}
export interface StageLogArgs {
  videoId?: string | null;
  stageRunId: string;
  stageName: string;
  fence: number;
}

const EVENT_LINE_MAX = 500;
const EVENT_BATCH_BYTES = 3000;

export function openStageLog(deps: StageLogDeps, a: StageLogArgs): StageLogHandle {
  const file = a.videoId ? stageLogPath(deps.storageRoot, a.videoId, a.stageName, a.fence) : null;
  const sink = file ? createLogSink(file, deps.capBytes, deps.io) : undefined;
  const flushMs = deps.flushMs ?? 1000;
  let pending: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastFlush = 0;
  let emits: Promise<unknown> = (deps.after ?? Promise.resolve()).catch(() => {});

  const flush = () => {
    timer = undefined;
    if (pending.length === 0) return;
    const lines: string[] = [];
    let size = 0;
    let dropped = 0;
    for (const l of pending) {
      const n = Buffer.byteLength(l);
      if (size + n > EVENT_BATCH_BYTES) { dropped++; continue; }
      lines.push(l);
      size += n;
    }
    pending = [];
    lastFlush = Date.now();
    const payload = { stage: a.stageName, lines, ...(dropped ? { dropped } : {}) };
    emits = emits.then(() =>
      emitEvent(deps.db, deps.bus, { type: "log", videoId: a.videoId ?? null, stageRunId: a.stageRunId, payload }).catch(() => {
        console.error(JSON.stringify({ event: "events.emit_failed", type: "log" }));
      }),
    );
  };

  return {
    write(line) {
      try {
        const clean = compactLine(redactLine(String(line)));
        sink?.write(clean);
        pending.push(clean.length > EVENT_LINE_MAX ? clean.slice(0, EVENT_LINE_MAX) + "..." : clean);
        if (!timer) {
          const wait = Math.max(0, lastFlush + flushMs - Date.now());
          timer = setTimeout(flush, wait);
          timer.unref?.();
        }
      } catch {
        // logging must never fail the stage
      }
    },
    async close() {
      if (timer) clearTimeout(timer);
      flush();
      await emits;
      await sink?.close();
    },
  };
}
