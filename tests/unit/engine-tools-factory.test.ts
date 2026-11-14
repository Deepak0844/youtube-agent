import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { StageContext } from "@/server/core/stage-handler";
import { buildEngineTools } from "@/server/engine/tools-factory";
import type { TsxRendererDeps } from "@/server/providers/renderer/tsx-render";

// The production wiring of the six engine tools: list_assets reaches the database with the search as a parameter (never in
// the SQL text), and every tool is there. Renders and probes are exercised by their own integration tests.

describe("buildEngineTools", () => {
  it("builds_the_six_tools_with_real_dependencies", async () => {
    const work = mkdtempSync(path.join(tmpdir(), "factory-"));
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const db = { query: async (text: string, values: unknown[]) => (queries.push({ text, values }), { rows: [{ id: "00000000-0000-0000-0000-000000000001", name: "whoosh", licence: "CC0", duration_s: "1.5" }] }) };
    const ctx = { claim: { stageRunId: "s1" }, signal: new AbortController().signal, attemptDir: work } as unknown as StageContext;
    const render = { kitDir: "/k", runChild: async () => ({ code: 0, signal: null, truncated: false, timedOut: false, aborted: false }), probe: async () => ({}) } as unknown as TsxRendererDeps;
    try {
      const tools = buildEngineTools({ db: db as never, ctx, workDir: work, orientation: "portrait", storageRoot: "/s", render });
      expect(tools.map((t) => t.name)).toEqual(["check_code", "preview_frames", "check_frames", "check_scenes", "preview_scenes", "list_assets", "fetch_asset"]);
      const out = await tools.find((t) => t.name === "list_assets")!.run({ kind: "sfx", query: "x' or 1=1" });
      expect(JSON.parse((out[0] as { text: string }).text)).toEqual([{ id: "audio:00000000-0000-0000-0000-000000000001", kind: "sfx", name: "whoosh", licence: "CC0", durationS: 1.5 }]);
      expect(queries[0]!.values).toEqual(["sfx", "x' or 1=1"]);
      expect(queries[0]!.text).not.toContain("1=1");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
