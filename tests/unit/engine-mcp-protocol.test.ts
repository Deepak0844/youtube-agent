import { describe, expect, it } from "vitest";
import { createMcpHandler, type McpTool } from "@/server/engine/mcp/protocol";

// The engine tools speak MCP (JSON-RPC 2.0, one message per line) to Claude Code. Hand-written on the owner's choice (no SDK):
// initialize, tools/list, tools/call and ping. Unknown methods are errors; notifications get no answer.

const echo: McpTool = {
  name: "echo",
  description: "Says the text back.",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
  run: async (args) => [{ type: "text", text: String((args as { text: string }).text) }],
};
const boom: McpTool = { name: "boom", description: "Fails.", inputSchema: { type: "object" }, run: async () => { throw new Error("secret detail /Users/x"); } };
const h = createMcpHandler([echo, boom], { name: "engine", version: "1" });
const call = async (msg: unknown) => {
  const out = await h(JSON.stringify(msg));
  return out === null ? null : JSON.parse(out);
};

describe("mcp handler", () => {
  it("answers initialize with tools capability and echoes a known protocol version", async () => {
    const r = await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "2" } } });
    expect(r).toEqual({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "engine", version: "1" } } });
  });
  it("falls back to its own protocol version for an unknown one", async () => {
    const r = await call({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } });
    expect(r.result.protocolVersion).toBe("2025-06-18");
  });
  it("gives no answer to notifications", async () => {
    expect(await call({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
  });
  it("lists the tools with their schemas", async () => {
    const r = await call({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    expect(r.result.tools.map((t: { name: string }) => t.name)).toEqual(["echo", "boom"]);
    expect(r.result.tools[0].inputSchema.required).toEqual(["text"]);
  });
  it("calls a tool", async () => {
    expect(await call({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "echo", arguments: { text: "hi" } } })).toEqual({ jsonrpc: "2.0", id: 4, result: { content: [{ type: "text", text: "hi" }] } });
  });
  it("a failing tool is a tool error with a fixed sentence (no detail leaks)", async () => {
    const r = await call({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "boom", arguments: {} } });
    expect(r.result).toEqual({ isError: true, content: [{ type: "text", text: "The tool failed. Try a different request." }] });
  });
  it("a tool can return its own plain error", async () => {
    const plain: McpTool = { ...echo, name: "plain", run: async () => { throw Object.assign(new Error("Frame 99 is outside the video (0-60)."), { toolMessage: true }); } };
    const r = JSON.parse((await createMcpHandler([plain], { name: "e", version: "1" })(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "plain", arguments: {} } }))) ?? "");
    expect(r.result).toEqual({ isError: true, content: [{ type: "text", text: "Frame 99 is outside the video (0-60)." }] });
  });
  it("refuses an unknown tool, an unknown method and bad JSON", async () => {
    expect((await call({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "nope", arguments: {} } })).error.code).toBe(-32602);
    expect((await call({ jsonrpc: "2.0", id: 7, method: "resources/list" })).error.code).toBe(-32601);
    expect(JSON.parse((await h("{not json")) ?? "").error.code).toBe(-32700);
  });
  it("answers ping", async () => {
    expect(await call({ jsonrpc: "2.0", id: 8, method: "ping" })).toEqual({ jsonrpc: "2.0", id: 8, result: {} });
  });
});
