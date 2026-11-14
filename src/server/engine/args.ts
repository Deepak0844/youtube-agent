// The Claude Code command line for the two engine run kinds (ADR 0015). Checked against claude 2.1.207. Claude starts INSIDE
// work/: its starting folder is trusted for reading (Read, Glob AND Grep), everything above it is denied in dontAsk mode (probed:
// a Grep of the starting folder read a file a Read(...) rule did not allow, so nothing secret may sit in the starting folder).
// Writes follow Edit(...) rules: allowed in ./** (build) or ./draft/** (research), denied for the read-only ./.claude (skills)
// and ./ref (brand, libraries, examples) and ./input (this run's own inputs: script, word times), with the after-run check
// as the backstop. No shell is
// offered or allowed in either kind; only a build run gets the app's engine tools (MCP server "engine"), and only a research
// run gets the web. Both get the Skill tool so the read-only skills in .claude/skills load (probed). No --disable-slash-commands:
// it also switches skills off (probed). Claude Code's own bundled skills then appear too; they are instructions only, and
// everything they could do still goes through this run's tool list (no shell, no web in a build run, writes only in work/). Prompts go through stdin, never through these arguments.

export type EngineRunKind = "research" | "build";

const READ_ONLY = ["Edit(./.claude/**)", "Edit(./ref/**)", "Edit(./input/**)"];
const NEVER = ["Bash", "BashOutput", "KillShell", "Agent", "Task", "NotebookEdit", "SlashCommand", "TodoWrite"];

export function engineArgs(kind: EngineRunKind, o: { mcpConfigPath?: string; maxTurns: number; model?: string }): string[] {
  const base = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "dontAsk", "--no-session-persistence", "--setting-sources", "project", "--max-turns", String(o.maxTurns)];
  const model = o.model && o.model !== "default" ? ["--model", o.model] : [];
  if (kind === "research") {
    return [
      ...base,
      "--tools", "Read,Glob,Grep,Write,Edit,Skill,WebSearch,WebFetch",
      "--allowedTools", "Edit(./draft/**),Skill,WebSearch,WebFetch",
      "--disallowedTools", [...NEVER, ...READ_ONLY].join(","),
      "--strict-mcp-config",
      ...model,
    ];
  }
  if (!o.mcpConfigPath) throw new Error("a build run needs the engine tools server config");
  return [
    ...base,
    "--tools", "Read,Glob,Grep,Write,Edit,Skill,mcp__engine__*",
    "--allowedTools", "Edit(./**),Skill,mcp__engine__*",
    "--disallowedTools", [...NEVER, "WebSearch", "WebFetch", ...READ_ONLY].join(","),
    "--mcp-config", o.mcpConfigPath,
    "--strict-mcp-config",
    ...model,
  ];
}
