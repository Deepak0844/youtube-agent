import { describe, expect, it } from "vitest";
import { buildEngineConfig } from "@/server/core/engine-config";
import { SETTINGS, SAFETY_KEYS } from "@/server/core/settings-registry";
import { engineArgs } from "@/server/engine/args";

// The two Claude Code run kinds of the new video engine (ADR 0015, engine-core spec). The exact flags were probed against
// claude 2.1.207 with Claude started INSIDE work/: writes follow Edit(...) rules; .claude and ref are denied.
const flag = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const list = (args: string[], name: string): string[] => (flag(args, name) ?? "").split(",").filter(Boolean);

describe("engineArgs", () => {
  it("research_run_has_web_and_no_shell_or_mcp", () => {
    const a = engineArgs("research", { maxTurns: 40 });
    expect(list(a, "--tools")).toEqual(expect.arrayContaining(["Read", "Glob", "Grep", "Write", "Edit", "Skill", "WebSearch", "WebFetch"]));
    expect(list(a, "--tools")).not.toContain("Bash");
    expect(list(a, "--allowedTools")).toEqual(["Edit(./draft/**)", "Skill", "WebSearch", "WebFetch"]);
    expect(list(a, "--disallowedTools")).toEqual(expect.arrayContaining(["Bash", "Agent", "Task", "Edit(./.claude/**)", "Edit(./ref/**)", "Edit(./input/**)"]));
    expect(a).not.toContain("--mcp-config");
    expect(a.join(" ")).not.toMatch(/mcp__/);
  });

  it("build_run_has_engine_tools_and_no_web_or_shell", () => {
    const a = engineArgs("build", { maxTurns: 80, mcpConfigPath: "/ws/mcp.json" });
    expect(list(a, "--tools")).toEqual(["Read", "Glob", "Grep", "Write", "Edit", "Skill", "mcp__engine__*"]);
    expect(list(a, "--allowedTools")).toEqual(["Edit(./**)", "Skill", "mcp__engine__*"]);
    expect(list(a, "--disallowedTools")).toEqual(expect.arrayContaining(["Bash", "WebSearch", "WebFetch", "Agent", "Task", "Edit(./.claude/**)", "Edit(./ref/**)", "Edit(./input/**)"]));
    expect(flag(a, "--mcp-config")).toBe("/ws/mcp.json");
    expect(a).toContain("--strict-mcp-config");
  });

  it("build_run_without_a_tools_server_is_refused", () => {
    expect(() => engineArgs("build", { maxTurns: 80 })).toThrow(/tools server/);
  });

  it("both_runs_are_headless_dontAsk_no_session", () => {
    for (const a of [engineArgs("research", { maxTurns: 40 }), engineArgs("build", { maxTurns: 80, mcpConfigPath: "/m.json" })]) {
      expect(a.slice(0, 1)).toEqual(["-p"]);
      expect(flag(a, "--output-format")).toBe("stream-json");
      expect(a).toContain("--verbose");
      expect(flag(a, "--permission-mode")).toBe("dontAsk");
      expect(a).toContain("--no-session-persistence");
      expect(flag(a, "--setting-sources")).toBe("project");
      expect(a).not.toContain("--disable-slash-commands"); // it would switch the skills off too (probed)
    }
    expect(flag(engineArgs("build", { maxTurns: 80, mcpConfigPath: "/m.json" }), "--max-turns")).toBe("80");
  });

  it("adds a model only when one is named", () => {
    expect(engineArgs("research", { maxTurns: 1 })).not.toContain("--model");
    expect(flag(engineArgs("research", { maxTurns: 1, model: "claude-opus-5-5" }), "--model")).toBe("claude-opus-5-5");
    expect(engineArgs("research", { maxTurns: 1, model: "default" })).not.toContain("--model");
  });
});

describe("engine settings", () => {
  it("settings_defaults_match_spec", () => {
    expect(buildEngineConfig(new Map()).engine).toEqual({ enabled: false, buildTimeoutS: 2700, longBuildTimeoutS: 5400, maxTurns: 150, limitRetryS: 1800, model: "sonnet" });
    for (const k of ["engine.enabled", "engine.build_timeout_s", "engine.long_build_timeout_s", "engine.max_turns", "engine.limit_retry_s", "engine.model"]) {
      expect(Object.hasOwn(SETTINGS, k), k).toBe(true);
      expect(SAFETY_KEYS as string[], k).toContain(k);
    }
  });
  it("engine_model_is_sonnet_or_opus", () => {
    expect(buildEngineConfig(new Map<string, unknown>([["engine.model", "opus"]])).engine.model).toBe("opus");
    expect(() => buildEngineConfig(new Map<string, unknown>([["engine.model", "haiku"]]))).toThrow(/engine\.model/);
  });
  it("refuses an invalid stored switch or limit", () => {
    expect(() => buildEngineConfig(new Map([["engine.enabled", "yes"]]))).toThrow(/engine\.enabled/);
    expect(() => buildEngineConfig(new Map([["engine.build_timeout_s", 30]]))).toThrow(/engine\.build_timeout_s/);
  });
});
