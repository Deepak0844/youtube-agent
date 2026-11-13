import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RELAY_PATH, startToolsHost } from "@/server/engine/mcp/host";
import type { McpTool } from "@/server/engine/mcp/protocol";

// The relay (what Claude Code starts) talks to the worker's host over a private socket with a one-time token.

const echo: McpTool = { name: "echo", description: "echo", inputSchema: { type: "object" }, run: async (a) => [{ type: "text", text: JSON.stringify(a) }] };
let runDir: string;
beforeEach(async () => {
  runDir = await mkdtemp(path.join(tmpdir(), "eng-run-"));
});
afterEach(async () => {
  await rm(runDir, { recursive: true, force: true });
});

function relay(env: Record<string, string>, lines: string[]): Promise<string[]> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [RELAY_PATH], { env: env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    p.stdout.on("data", (c: Buffer) => (out += c.toString()));
    p.on("close", () => resolve(out.split("\n").filter(Boolean)));
    for (const l of lines) p.stdin.write(l + "\n");
    setTimeout(() => p.stdin.end(), 500);
  });
}

describe("engine tools host and relay", () => {
  it("answers in order through the relay, and writes a private config", async () => {
    const host = await startToolsHost({ runDir, tools: [echo] });
    try {
      const cfg = JSON.parse(await readFile(host.mcpConfigPath, "utf8")).mcpServers.engine;
      expect((await stat(host.mcpConfigPath)).mode & 0o077).toBe(0);
      expect(cfg.args).toEqual([RELAY_PATH]);
      const lines = await relay(cfg.env, [
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }),
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: { a: 1 } } }),
      ]);
      expect(lines.map((l) => JSON.parse(l).id)).toEqual([1, 2]);
      expect(JSON.parse(lines[1]!).result.content[0].text).toBe('{"a":1}');
    } finally {
      await host.close();
    }
    await expect(stat(host.mcpConfigPath)).rejects.toThrow(); // removed on close
  });

  it("a wrong token gets no answers", async () => {
    const host = await startToolsHost({ runDir, tools: [echo] });
    try {
      const cfg = JSON.parse(await readFile(host.mcpConfigPath, "utf8")).mcpServers.engine;
      const lines = await relay({ ...cfg.env, ENGINE_TOKEN: "0".repeat(64) }, [JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })]);
      expect(lines).toEqual([]);
    } finally {
      await host.close();
    }
  });
});
