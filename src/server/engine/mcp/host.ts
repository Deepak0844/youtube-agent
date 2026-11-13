import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMcpHandler, type McpTool } from "./protocol";

// The worker side of the engine tools (ADR 0015). Listens on a private unix socket in a fresh 0700 temp folder (short path:
// macOS caps socket paths at 104 bytes) and accepts only requests carrying this run's one-time token. Writes the MCP config
// Claude Code loads (`--mcp-config`) into the run folder, outside work/, so Claude cannot read the token with its file tools.

export const RELAY_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "relay.mjs");
const MAX_BODY = 256 * 1024;

export interface ToolsHost {
  mcpConfigPath: string;
  close(): Promise<void>;
}

export async function startToolsHost(o: { runDir: string; tools: readonly McpTool[]; nodePath?: string }): Promise<ToolsHost> {
  const sockDir = await mkdtemp(path.join(tmpdir(), "eng-"));
  const sock = path.join(sockDir, "t.sock");
  const token = randomBytes(32).toString("hex");
  const want = Buffer.from(`Bearer ${token}`);
  const handle = createMcpHandler(o.tools, { name: "engine", version: "1" });
  const server: Server = createServer((req, res) => {
    const got = Buffer.from(String(req.headers.authorization ?? ""));
    if (req.method !== "POST" || req.url !== "/mcp" || got.length !== want.length || !timingSafeEqual(got, want)) {
      res.writeHead(403).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) req.destroy();
      else chunks.push(c);
    });
    req.on("end", () => {
      void handle(Buffer.concat(chunks).toString("utf8")).then(
        (out) => (out === null ? res.writeHead(204).end() : res.writeHead(200, { "content-type": "application/json" }).end(out)),
        () => res.writeHead(500).end(),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(sock, () => resolve());
  });
  const mcpConfigPath = path.join(o.runDir, "mcp.json");
  const config = { mcpServers: { engine: { type: "stdio", command: o.nodePath ?? process.execPath, args: [RELAY_PATH], env: { ENGINE_SOCK: sock, ENGINE_TOKEN: token } } } };
  await writeFile(mcpConfigPath, JSON.stringify(config), { mode: 0o600 });
  return {
    mcpConfigPath,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(sockDir, { recursive: true, force: true });
      await rm(mcpConfigPath, { force: true });
    },
  };
}
