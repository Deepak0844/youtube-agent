import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import type { EngineConfig } from "@/server/core/engine-config";
import { finishEngineRun, startEngineRun, type EngineUsage } from "@/server/db/engine-runs";
import { minimalEnv } from "@/server/llm/claude-code";
import type { ChildRegistry } from "@/server/render/child";
import { argsHash, commandLabelOf, readProcInfo } from "@/server/render/proc-info";
import { engineArgs, type EngineRunKind } from "./args";
import { parseLimit } from "./limit";
import { startToolsHost, type ToolsHost } from "./mcp/host";
import type { McpTool } from "./mcp/protocol";
import { checkAfterRun, engineKitSeeds, prepareWorkspace, type Workspace, type WorkspaceSeeds } from "./workspace";

/** The repository the worker runs from (engine-kit/ lives at its root). */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

// Launches one Claude Code engine run (ADR 0015): a fresh locked folder, the run kind's fixed flags, Claude started INSIDE
// work/, the minimal environment (no secrets), the engine tools host for build runs, a time limit and cancel that kill the
// whole process group, the after-run folder check, and one engine_runs row with Claude's own usage figures. Every outcome is
// one plain sentence; nothing Claude printed is echoed.

export interface EngineDeps {
  db: pg.Pool;
  /** Where run folders live: defaultEngineRoot() in production. Must not sit inside a folder with Claude Code project settings. */
  root: string;
  config: EngineConfig["engine"];
  /** Default: the `claude` program. Tests run a scripted fake. */
  command?: { cmd: string; prefix: string[] };
  /** Source of the allow-listed environment variables (default process.env). */
  env?: Record<string, string | undefined>;
  /** Default: engine-kit/ (skills, brand rules, old shorts, library index). */
  seeds?: WorkspaceSeeds;
  /** The engine tools of a build run, made for this run's workspace. */
  tools?: (ws: Workspace) => McpTool[];
  registry?: ChildRegistry;
  now?: () => Date;
  killGraceMs?: number;
  maxStdoutBytes?: number;
}
export interface EngineRequest {
  videoId: string;
  stageRunId: string;
  kind: EngineRunKind;
  prompt: string;
  long: boolean;
  signal: AbortSignal;
  model?: string;
}
export type EngineResult =
  | { ok: true; text: string; usage: EngineUsage; turns: number; workDir: string }
  | { ok: false; limit: true; resumeAt: Date }
  | { ok: false; limit: false; message: string };

const say = (message: string): EngineResult => ({ ok: false, limit: false, message });
const MAX_STDOUT = 32 * 1024 * 1024;

interface Exit { code: number | null; timedOut: boolean; aborted: boolean; result: Record<string, unknown> | null }

function launch(d: EngineDeps, ws: Workspace, args: string[], prompt: string, timeoutMs: number, signal: AbortSignal, stageRunId: string): Promise<Exit> {
  return new Promise((resolve) => {
    const cmd = d.command ?? { cmd: "claude", prefix: [] };
    const child = spawn(cmd.cmd, [...cmd.prefix, ...args], { cwd: ws.workDir, env: minimalEnv(d.env ?? process.env) as NodeJS.ProcessEnv, shell: false, detached: true, stdio: ["pipe", "pipe", "ignore"] as const });
    const started = Date.now();
    let timedOut = false;
    let aborted = false;
    let result: Record<string, unknown> | null = null;
    let size = 0;
    let buf = "";
    const killGroup = () => {
      const pid = child.pid;
      if (!pid) return;
      try { process.kill(-pid, "SIGTERM"); } catch { /* gone */ }
      setTimeout(() => { try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } }, d.killGraceMs ?? 2000).unref();
    };
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, timeoutMs);
    const onAbort = () => { aborted = true; killGroup(); };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    // Registered with the identity the orphan sweep checks (ps start time and args hash), as runChild does, so a worker crash
    // never leaves Claude running unseen. If the process cannot be tracked, it is stopped at once.
    let startedAtEpoch = Math.floor(started / 1000);
    let registered = false;
    if (child.pid && d.registry) {
      const pid = child.pid;
      void (async () => {
        const info = await readProcInfo(pid);
        if (!info) return; // already gone
        startedAtEpoch = info.startedAtEpoch;
        await d.registry!.register({ pid, startedAtEpoch, commandLabel: commandLabelOf(info.args), argsSha256: argsHash(info.args), stageRunId });
        registered = true;
      })().catch(() => killGroup());
    }
    child.stdout.on("data", (c: Buffer) => {
      size += c.length;
      if (size > (d.maxStdoutBytes ?? MAX_STDOUT)) { killGroup(); return; }
      buf += c.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          const m = JSON.parse(line) as Record<string, unknown>;
          if (m.type === "result") result = m;
        } catch { /* not a message */ }
      }
    });
    child.on("error", () => undefined);
    child.on("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (child.pid && d.registry && registered) void d.registry.unregister(child.pid, startedAtEpoch).catch(() => undefined);
      resolve({ code, timedOut, aborted, result });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(prompt);
  });
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

export async function runEngine(d: EngineDeps, req: EngineRequest): Promise<EngineResult> {
  if (!d.config.enabled) return say("The new engine is switched off in Settings.");
  const started = await startEngineRun(d.db, { videoId: req.videoId, stageRunId: req.stageRunId, kind: req.kind });
  if (!started.ok) return say("Another engine run of this video is still going.");
  const runId = started.id;
  let host: ToolsHost | null = null;
  try {
    const ws = await prepareWorkspace(d.root, req.videoId, d.seeds ?? engineKitSeeds(REPO_ROOT));
    if (req.kind === "build") host = await startToolsHost({ runDir: ws.dir, tools: d.tools?.(ws) ?? [] });
    const before = await ws.snapshot();
    const args = engineArgs(req.kind, { maxTurns: d.config.maxTurns, model: req.model, ...(host ? { mcpConfigPath: host.mcpConfigPath } : {}) });
    const limitS = req.long ? d.config.longBuildTimeoutS : d.config.buildTimeoutS;
    const exit = await launch(d, ws, args, req.prompt, limitS * 1000, req.signal, req.stageRunId);
    const after = await ws.snapshot(); // before the host closes: closing removes its config file from the run folder
    await host?.close();
    host = null;
    const r = exit.result;
    const usage: EngineUsage = { inputTokens: num((r?.usage as Record<string, unknown> | undefined)?.input_tokens), outputTokens: num((r?.usage as Record<string, unknown> | undefined)?.output_tokens), costUsdEquiv: num(r?.total_cost_usd) };
    const turns = num(r?.num_turns);
    const end = async (status: "succeeded" | "failed" | "killed", message: string | null, ok?: EngineResult): Promise<EngineResult> => {
      await finishEngineRun(d.db, runId, { status, usage, turns, ...(message ? { error: message } : {}) });
      return ok ?? say(message ?? "Claude Code stopped with an error.");
    };
    if (exit.aborted) return end("killed", "The run was cancelled.");
    if (exit.timedOut) return end("killed", `The Claude run took longer than its ${Math.max(1, Math.round(limitS / 60))} min limit and was stopped.`);
    const problems = checkAfterRun(before, after);
    if (problems.length > 0) return end("failed", `The run broke its folder rules (${problems.slice(0, 3).join("; ")}).`);
    const text = typeof r?.result === "string" ? r.result : "";
    if (r?.is_error === true) {
      const lim = parseLimit(text, (d.now ?? (() => new Date()))());
      if (lim.limit) {
        const now = (d.now ?? (() => new Date()))();
        const resumeAt = lim.resumeAt ?? new Date(now.getTime() + d.config.limitRetryS * 1000);
        await finishEngineRun(d.db, runId, { status: "limit", usage, turns, resumeAt });
        return { ok: false, limit: true, resumeAt };
      }
    }
    if (r?.subtype === "error_max_turns") return end("failed", "Claude used all its turns without finishing.");
    if (!r || r.is_error === true || r.subtype !== "success" || exit.code !== 0) return end("failed", "Claude Code stopped with an error.");
    return end("succeeded", null, { ok: true, text, usage, turns, workDir: ws.workDir });
  } catch {
    await finishEngineRun(d.db, runId, { status: "failed", error: "The engine run could not be set up." }).catch(() => undefined);
    return say("The engine run could not be set up.");
  } finally {
    await host?.close().catch(() => undefined);
  }
}
