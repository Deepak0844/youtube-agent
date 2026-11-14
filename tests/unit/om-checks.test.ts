import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateComposition } from "@/server/engine/om-checks/composition";
import { scoreSlideshowRisk } from "@/server/engine/om-checks/slideshow-risk";
import { classifyFromBrief, validateCuts } from "@/server/engine/om-checks/delivery-promise";
import { checkAlignment, traceTerminalSteps } from "@/server/engine/om-checks/scene-pacing";
import { pyFixed, pyRound } from "@/server/engine/om-checks/py";
import { omThemeConfig, themeFromPlaybook } from "@/server/engine/om-checks/theme";
import { parse as parseYaml } from "yaml";

// OpenMontage parity, Phase B: the TypeScript ports of OpenMontage's pre-render checks give the same answers as its Python on
// golden cases (tests/fixtures/openmontage/goldens, made once by running the Python in the upstream clone).

const GOLD = "tests/fixtures/openmontage/goldens";
const goldens = (prefix: string) =>
  readdirSync(GOLD).filter((f) => f.startsWith(prefix)).map((f) => [f, JSON.parse(readFileSync(path.join(GOLD, f), "utf8"))] as const);

describe("composition validator port", () => {
  it.each(goldens("composition-"))("matches_openmontage_on %s", (_name, g) => {
    const files = g.files as Record<string, number | null>;
    const r = validateComposition(g.input, { exists: (n) => Object.hasOwn(files, n), durationS: (n) => files[n] ?? null });
    expect({ valid: r.ok, errors: r.errors, warnings: r.warnings }).toEqual(g.expected);
  });

  it("has_the_cases", () => {
    expect(goldens("composition-").length).toBe(7);
  });
});

describe("slideshow risk port", () => {
  it.each(goldens("slideshow-"))("slideshow_risk_matches_openmontage %s", (_name, g) => {
    expect(scoreSlideshowRisk(g.scenes, null, g.rendererFamily)).toEqual(g.expected);
  });

  it("has_the_cases", () => {
    expect(goldens("slideshow-").length).toBe(8);
  });
});

describe("delivery promise port", () => {
  it.each(goldens("promise-"))("delivery_promise_matches_openmontage %s", (_name, g) => {
    const promise = { ...classifyFromBrief(g.pipeline, g.intent), approved_fallback: g.approvedFallback };
    expect(promise).toEqual(g.expected.promise);
    expect(validateCuts(promise, g.cuts)).toEqual(g.expected.check);
  });

  it("has_the_cases", () => {
    expect(goldens("promise-").length).toBe(8);
  });
});

describe("scene pacing port", () => {
  it.each(goldens("pacing-"))("scene_pacing_matches_openmontage %s", (_name, g) => {
    expect(traceTerminalSteps(g.steps, g.sceneStart)).toEqual(g.expected.landmarks);
    expect(checkAlignment(g.steps, g.sceneStart, g.sceneEnd, g.cues, g.tolerance)).toEqual(g.expected.problems);
  });

  it("has_the_cases", () => {
    expect(goldens("pacing-").length).toBe(5);
  });
});

describe("Python number formatting", () => {
  it("rounds_like_python", () => {
    // exact binary halves go to even; values just below a half (1.015 is 1.01499...) go down
    expect([pyRound(1.25, 1), pyRound(0.125, 2), pyRound(2.5), pyRound(3.5), pyRound(1.015, 2), pyRound(2.675, 2), pyRound(-1.25, 1)]).toEqual([1.2, 0.12, 2, 4, 1.01, 2.67, -1.2]);
    expect([pyFixed(12.125, 2), pyFixed(1.005, 2), pyFixed(-4.125, 2), pyFixed(0, 1)]).toEqual(["12.12", "1.00", "-4.12", "0.0"]);
  });
});

describe("playbook theme port", () => {
  const playbook = (style: string) => parseYaml(readFileSync(`engine-kit/openmontage/ref/styles/${style}.yaml`, "utf8")) as Record<string, unknown>;

  it.each(goldens("theme-"))("theme_matches_openmontage %s", (_name, g) => {
    expect(themeFromPlaybook(playbook(g.style))).toEqual(g.expected);
  });

  it("theme_files_match_the_styles", () => {
    // the sync command pre-computes these; a style changed without re-syncing fails here
    for (const [, g] of goldens("theme-")) expect(omThemeConfig(g.style)).toEqual(themeFromPlaybook(playbook(g.style)));
    expect(goldens("theme-").length).toBe(5);
  });

  it("unknown_or_path_style_gives_null", () => {
    for (const bad of ["made-up", "../themes/clean-professional", "", "Clean-Professional", "a".repeat(41)]) expect(omThemeConfig(bad), bad).toBeNull();
  });
});
