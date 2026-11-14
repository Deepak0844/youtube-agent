import { describe, expect, it } from "vitest";
import { buildEngineConfig } from "@/server/core/engine-config";
import { usesEngineDraft } from "@/worker/stages/engine-draft";

const ON = buildEngineConfig(new Map<string, unknown>([["engine.enabled", true]]));
const OFF = buildEngineConfig(new Map());

describe("usesEngineDraft", () => {
  it("engine_off_keeps_the_paid_draft", () => {
    expect(usesEngineDraft(OFF, "short")).toBe(false);
    expect(usesEngineDraft(OFF, "long")).toBe(false);
  });
  it("engine_on_short_uses_the_engine", () => {
    expect(usesEngineDraft(ON, "short")).toBe(true);
  });
  it("engine_on_long_keeps_the_paid_draft", () => {
    expect(usesEngineDraft(ON, "long")).toBe(false);
  });
  it("an_unknown_format_keeps_the_paid_draft", () => {
    expect(usesEngineDraft(ON, "")).toBe(false);
  });
});
