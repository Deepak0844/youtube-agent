import { describe, expect, it } from "vitest";
import { evaluate, exitCode, exitVerdict, formatChecklist, formatPlan, nominalCostMicro, type Facts, type RunSummary } from "@/server/core/phase4-exit";

const good: Facts = {
  db: { reachable: true, migrated: true }, redisConfigured: true,
  voiceUrl: "http://127.0.0.1:8123", voiceListed: true, voiceReachable: true,
  models: ["draft", "build_scene_kit"].map((stage) => ({ stage, routed: true, enabled: true, priced: true, provider: "gemini", label: "Flash", keyPresent: true })),
  docker: { daemon: true, image: true }, ffmpeg: true, ffprobe: true, freeDiskGb: 50, load1: 1, cores: 8,
  budgets: { dayCapMicro: 15_000_000, dayRemainingMicro: 15_000_000, draftRunCapMicro: 3_000_000 },
  searxUrl: "http://127.0.0.1:8888", searxReachable: true, voiceRoute: { provider: "voicestudio" },
};
const levels = (f: Facts) => evaluate(f).map((l) => l.level);

describe("preflight", () => {
  it("all good: no block, no warn, exit 0, six languages", () => {
    const l = evaluate(good);
    expect(exitCode(l)).toBe(0);
    expect(levels(good)).not.toContain("WARN");
    expect(l.filter((x) => x.label.startsWith("Language ")).length).toBe(6);
    expect(l.find((x) => x.label === "Language ml")!.detail).toContain("estimated");
  });
  it("high load warns with advice, does not block", () => {
    const l = evaluate({ ...good, load1: 6 });
    expect(l.find((x) => x.label === "Machine load")).toMatchObject({ level: "WARN" });
    expect(formatChecklist(l)).toContain("Close heavy apps");
    expect(exitCode(l)).toBe(0);
  });
  it("blocks: unpriced model, missing key, unlisted voice, no docker image, searx down", () => {
    const bad: Facts = { ...good, voiceListed: false, docker: { daemon: true, image: false }, searxReachable: false,
      models: [{ ...good.models[0]!, priced: false }, { ...good.models[1]!, keyPresent: false }] };
    const l = evaluate(bad).filter((x) => x.level === "BLOCK").map((x) => x.label);
    expect(l).toEqual(expect.arrayContaining(["Model for draft", "Model for build_scene_kit", "Local services list", "Render image", "SearXNG"]));
    expect(exitCode(evaluate(bad))).toBe(1);
  });
  it("unset VoiceStudio and used-up day budget block", () => {
    expect(exitCode(evaluate({ ...good, voiceUrl: "" }))).toBe(1);
    expect(exitCode(evaluate({ ...good, budgets: { ...good.budgets, dayRemainingMicro: 0 } }))).toBe(1);
  });
});

describe("plan", () => {
  const m = { stage: "draft", label: "Flash", provider: "gemini", inPerMTokMicro: 100_000, outPerMTokMicro: 400_000 };
  it("costs from the price card and shows free tier", () => {
    expect(nominalCostMicro(m)).toBe(10_800);
    const t = formatPlan({ lang: "hi", steps: [{ stage: "draft", gateAfter: "script" }, { stage: "qa", gateAfter: "video" }], models: [m], videoCapMicro: 2_000_000 });
    expect(t).toContain("real cost $0");
    expect(t).toContain("/videos/new");
    expect(t).toContain('"script" approval');
  });
});

describe("exit verdict", () => {
  const ok: RunSummary = {
    stages: ["draft", "build", "tts", "render", "voice", "sfx", "qa"].map((stage) => ({ stage, status: "succeeded", durationMs: 1000 })), plannedStages: [],
    scriptApproved: true, renderExists: true, qaBlocks: 0, qaWarns: 1, videoGateOpen: true, videoApproved: false, spendMicro: 0, capMicro: 2_000_000, timingKind: "aligned",
  };
  it("passes when the whole route is reached", () => expect(exitVerdict(ok).pass).toBe(true));
  it("fails and says what is missing", () => {
    const v = exitVerdict({ ...ok, renderExists: false, qaBlocks: 2, stages: [...ok.stages.slice(0, 3), { stage: "render", status: "failed", durationMs: null }] });
    expect(v.pass).toBe(false);
    expect(v.missing.join(" ")).toContain("render");
    expect(v.missing.join(" ")).toContain("stage render is failed");
  });
});
