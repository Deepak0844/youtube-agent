import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OM_LIBS } from "@/server/core/om-names";
import { checkTsx } from "@/server/core/tsx-check";
import { typeCheckInThread } from "@/server/providers/renderer/tsx-render";
import { buildOmDts, componentFiles, INDEX_FILE, indexDoc, NAMES_FILE, namesModule, TYPES_DIR } from "../../scripts/sync-om-dts";

// OpenMontage parity, Phase C (bespoke path): code scenes may import OpenMontage's composer components as "yt-om/<Component>",
// one module per component file. The names, declarations and Claude's index are GENERATED (scripts/sync-om-dts.ts) and the
// static check allows exactly them; anything else under yt-om is refused.

const scene = (imports: string, body = "<AbsoluteFill />") => `import { AbsoluteFill } from "remotion";
${imports}
export default function Scene() {
  return ${body};
}
export const meta = { durationInFrames: 90, fps: 30, width: 1080, height: 1920 };
`;

describe("yt-om declarations and names", () => {
  const dts = buildOmDts();

  it("generated_names_match_the_components", () => {
    expect(readFileSync(NAMES_FILE, "utf8")).toBe(namesModule(dts));
    expect(readFileSync(INDEX_FILE, "utf8")).toBe(indexDoc(dts));
    for (const [rel, text] of dts) expect(readFileSync(path.join(TYPES_DIR, rel), "utf8"), rel).toBe(text);
  });

  it("covers_the_kept_components_and_nothing_else", () => {
    expect(Object.keys(OM_LIBS).sort()).toEqual(componentFiles().map((f) => `yt-om/${path.basename(f).replace(/\.tsx$/, "")}`).sort());
    for (const m of ["yt-om/HeroTitle", "yt-om/BarChart", "yt-om/TerminalScene", "yt-om/KPIGrid"]) expect(OM_LIBS[m], m).toBeDefined();
    for (const m of ["yt-om/AnimeScene", "yt-om/ScreenshotScene", "yt-om/ProviderChip", "yt-om/index"]) expect(OM_LIBS[m], m).toBeUndefined();
    expect(OM_LIBS["yt-om/HeroTitle"]).toEqual(["HeroTitle"]);
  });
});

describe("yt-om imports in the static check", () => {
  it("allows_yt_om_component_imports", () => {
    expect(checkTsx(scene(`import { HeroTitle } from "yt-om/HeroTitle";\nimport { BarChart } from "yt-om/BarChart";`, `<AbsoluteFill><HeroTitle title="Hi" /></AbsoluteFill>`)).problems).toEqual([]);
  });

  it("refuses_yt_om_paths_and_unknown_names", () => {
    expect(checkTsx(scene(`import { Nope } from "yt-om/HeroTitle";`)).problems.join(" ")).toMatch(/Nope/);
    for (const spec of ["yt-om/../om/Root", "yt-om/charts/BarChart", "yt-om/AnimeScene", "yt-om/index", "yt-om", "yt-om/", "yt-om/heroTitle", "yt-om/./HeroTitle"]) {
      expect(checkTsx(scene(`import { X } from "${spec}";`)).ok, spec).toBe(false);
    }
  });
});

describe("the data prop of OpenMontage's charts", () => {
  // 'data' is a URL attribute on <object>, so the check refuses it unless it is staticFile(...). OpenMontage's BarChart and
  // PieChart take their numbers as a prop named data and draw them as SVG shapes: allowed on exactly those two yt-om imports.
  const chart = `[{ label: "A", value: 3 }]`;
  it("allows_data_on_yt_om_BarChart_and_PieChart", () => {
    expect(checkTsx(scene(`import { BarChart } from "yt-om/BarChart";`, `<BarChart data={${chart}} />`)).problems).toEqual([]);
    expect(checkTsx(scene(`import { PieChart } from "yt-om/PieChart";`, `<PieChart data={${chart}} />`)).problems).toEqual([]);
  });

  it("still_refuses_data_anywhere_else", () => {
    expect(checkTsx(scene("", `<object data="https://x.test/a" />`)).ok).toBe(false);
    expect(checkTsx(scene("", `<div data={"https://x.test/a"} />`)).ok).toBe(false);
    expect(checkTsx(scene(`import { HeroTitle } from "yt-om/HeroTitle";`, `<HeroTitle title="x" {...{}} data="https://x.test/a" />`)).problems.join(" ")).toMatch(/'data' must be staticFile/);
    const local = `const BarChart = (p: { data: unknown }) => <div />;\n`;
    expect(checkTsx(scene(local, `<BarChart data={"https://x.test/a"} />`)).problems.join(" ")).toMatch(/'data' must be staticFile/);
  });
});

describe("yt-om in the type-check", () => {
  it("typecheck_resolves_yt_om", async () => {
    const r = await typeCheckInThread(scene(`import { HeroTitle } from "yt-om/HeroTitle";`, `<AbsoluteFill><HeroTitle title="Hi" subtitle="there" /></AbsoluteFill>`), 60_000);
    expect(r.problems).toEqual([]);
  }, 90_000);

  it("a_wrong_prop_fails_the_type_check", async () => {
    const r = await typeCheckInThread(scene(`import { HeroTitle } from "yt-om/HeroTitle";`, `<AbsoluteFill><HeroTitle nope={1} /></AbsoluteFill>`), 60_000);
    expect(r.ok).toBe(false);
  }, 90_000);
});
