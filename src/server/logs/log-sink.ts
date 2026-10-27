import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

// Capped, never-throwing log file for one stage attempt. A stage must not fail or hang because its log did:
// every error here is reported once on the worker console (no line content) and the sink goes quiet.
export interface LogSink {
  write(line: string): void;
  close(): Promise<void>;
}
export interface LogIo {
  mkdir(dir: string): Promise<unknown>;
  append(file: string, data: string): Promise<unknown>;
}
const realIo: LogIo = {
  mkdir: (dir) => mkdir(dir, { recursive: true }),
  append: (file, data) => appendFile(file, data, { mode: 0o600 }),
};

export const TRUNCATED_MARKER = "[log truncated]";

export function createLogSink(file: string, capBytes: number, io: LogIo = realIo): LogSink {
  let written = 0;
  let stopped = false; // no more lines accepted (cap reached, closed, or failed)
  let failed = false;
  let chain: Promise<void> = Promise.resolve();
  let dirReady = false;

  const quiet = (err: unknown) => {
    if (failed) return;
    failed = true;
    stopped = true;
    const code = typeof err === "object" && err && "code" in err ? String((err as { code: unknown }).code) : "error";
    console.error(JSON.stringify({ event: "log_sink.disabled", code }));
  };
  const enqueue = (data: string) => {
    chain = chain.then(async () => {
      if (failed) return;
      try {
        if (!dirReady) { await io.mkdir(path.dirname(file)); dirReady = true; }
        await io.append(file, data);
      } catch (err) { quiet(err); }
    });
  };

  return {
    write(line) {
      if (stopped) return;
      try {
        const text = line.endsWith("\n") ? line : line + "\n";
        const size = Buffer.byteLength(text);
        if (written + size > capBytes) {
          stopped = true; // later lines are dropped; the marker is the last thing in the file
          enqueue(TRUNCATED_MARKER + "\n");
          return;
        }
        written += size;
        enqueue(text);
      } catch (err) { quiet(err); }
    },
    async close() {
      stopped = true;
      await chain;
    },
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STAGE = /^[a-z0-9_-]{1,40}$/i;

/** `<root>/videos/<videoId>/logs/<stage>-<fence>.log`, or null when a part is not a plain id (never builds a traversal). */
export function stageLogPath(root: string, videoId: string, stage: string, fence: number): string | null {
  if (!UUID.test(videoId) || !STAGE.test(stage) || !Number.isInteger(fence) || fence < 0) return null;
  return path.join(root, "videos", videoId, "logs", `${stage}-${fence}.log`);
}
