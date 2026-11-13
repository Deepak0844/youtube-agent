// The Claude Code command line for the two engine run kinds (ADR 0015). Checked against claude 2.1.207: file writes follow
// Edit(...) rules and reads follow Read(...) rules, relative to the run's folder, so `./work/**` confines both. No shell is
// offered or allowed in either kind; only a build run gets the app's engine tools (MCP server "engine"), and only a research
// run gets the web. Prompts go through stdin, never through these arguments.

export type EngineRunKind = "research" | "build";

const NEVER = ["Bash", "BashOutput", "KillShell", "Agent", "Task", "NotebookEdit", "SlashCommand", "TodoWrite"];

export function engineArgs(kind: EngineRunKind, o: { mcpConfigPath?: string; maxTurns: number; model?: string }): string[] {
  const base = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "dontAsk", "--no-session-persistence", "--setting-sources", "project", "--disable-slash-commands", "--max-turns", String(o.maxTurns)];
  const model = o.model && o.model !== "default" ? ["--model", o.model] : [];
  if (kind === "research") {
    return [
      ...base,
      "--tools", "Read,Glob,Grep,Write,Edit,WebSearch,WebFetch",
      "--allowedTools", "Read(./work/**),Edit(./work/draft/**),WebSearch,WebFetch",
      "--disallowedTools", NEVER.join(","),
      "--strict-mcp-config",
      ...model,
    ];
  }
  if (!o.mcpConfigPath) throw new Error("a build run needs the engine tools server config");
  return [
    ...base,
    "--tools", "Read,Glob,Grep,Write,Edit,mcp__engine__*",
    "--allowedTools", "Read(./work/**),Edit(./work/**),mcp__engine__*",
    "--disallowedTools", [...NEVER, "WebSearch", "WebFetch"].join(","),
    "--mcp-config", o.mcpConfigPath,
    "--strict-mcp-config",
    ...model,
  ];
}
