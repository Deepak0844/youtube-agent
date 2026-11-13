// A minimal MCP server handler (JSON-RPC 2.0, one message per line) for the engine tools (ADR 0015). Hand-written on the
// owner's choice instead of the SDK: only initialize, notifications, ping, tools/list and tools/call. A tool error becomes a
// fixed sentence unless the tool marked its own message as safe to show (`toolMessage: true`); nothing else leaks.

export type McpContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: "image/png" | "image/jpeg" };
export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: unknown): Promise<McpContent[]>;
}

const VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const FAILED = "The tool failed. Try a different request.";

/** A plain sentence the model may see (thrown by a tool). */
export class ToolMessage extends Error {
  readonly toolMessage = true;
}

const ok = (id: unknown, result: unknown) => JSON.stringify({ jsonrpc: "2.0", id, result });
const err = (id: unknown, code: number, message: string) => JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

/** Returns the answer line for one incoming line, or null for a notification. */
export function createMcpHandler(tools: readonly McpTool[], info: { name: string; version: string }): (line: string) => Promise<string | null> {
  const byName = new Map(tools.map((t) => [t.name, t]));
  return async (line) => {
    let m: { id?: unknown; method?: unknown; params?: Record<string, unknown> };
    try {
      m = JSON.parse(line);
    } catch {
      return err(null, -32700, "Parse error");
    }
    if (typeof m !== "object" || m === null || typeof m.method !== "string") return err(m?.id, -32600, "Invalid request");
    const isNote = m.id === undefined || m.id === null;
    if (m.method.startsWith("notifications/")) return null;
    if (isNote) return null;
    switch (m.method) {
      case "initialize": {
        const asked = m.params?.protocolVersion;
        const protocolVersion = typeof asked === "string" && VERSIONS.includes(asked) ? asked : VERSIONS[0];
        return ok(m.id, { protocolVersion, capabilities: { tools: {} }, serverInfo: info });
      }
      case "ping":
        return ok(m.id, {});
      case "tools/list":
        return ok(m.id, { tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
      case "tools/call": {
        const tool = typeof m.params?.name === "string" ? byName.get(m.params.name) : undefined;
        if (!tool) return err(m.id, -32602, "Unknown tool");
        try {
          return ok(m.id, { content: await tool.run(m.params?.arguments ?? {}) });
        } catch (e) {
          const text = e instanceof Error && (e as { toolMessage?: unknown }).toolMessage === true ? e.message.slice(0, 2000) : FAILED;
          return ok(m.id, { isError: true, content: [{ type: "text", text }] });
        }
      }
      default:
        return err(m.id, -32601, "Method not found");
    }
  };
}
