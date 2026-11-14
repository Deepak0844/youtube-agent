import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { engineKitSeeds, prepareWorkspace } from "@/server/engine/workspace";

// The engine's seeds (old-kit-import): skills rewritten for the engine's tools, the old shorts as read-only examples, and the
// library index, copied into every run.

const OM_REF = "engine-kit/openmontage/ref";
const TOOL_MAP = readFileSync(path.join(OM_REF, "TOOL-MAP.md"), "utf8");
const walkFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walkFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]));
/** OpenMontage's seeded guides (not our TOOL-MAP). */
const guides = () => walkFiles(OM_REF).filter((f) => /\.(md|yaml)$/.test(f) && !f.endsWith("TOOL-MAP.md"));
const skills = readdirSync("engine-kit/skills").map((d) => path.join("engine-kit/skills", d, "SKILL.md"));

describe("engine-kit seeds", () => {
  it("skills_mention_only_engine_tools", () => {
    expect(skills.length).toBe(6);
    for (const f of skills) {
      const t = readFileSync(f, "utf8");
      expect(t, f).not.toMatch(/\bpython3?\b|\bnpm\b|node (remotion|scripts)|Bash\(|tools\/[a-z_]+\.py|ElevenLabs/);
      expect(t, f).toMatch(/^---\nname: [a-z0-9-]+\ndescription: /);
    }
    expect(readFileSync("engine-kit/skills/make-short/SKILL.md", "utf8")).toMatch(/preview_frames[\s\S]*check_code|check_code[\s\S]*preview_frames/);
  });

  it("draw_objects_keeps_labels_off_the_picture", () => {
    const t = readFileSync("engine-kit/skills/draw-objects/SKILL.md", "utf8");
    expect(t).toMatch(/Labels never touch the picture/);
    expect(t).toMatch(/labelY = objectBottom \+ 28 \+ fontSize/);
    expect(t).toMatch(/at least 40 px/);
  });

  it("every_path_a_guide_names_is_seeded_or_mapped", () => {
    // a guide pointing at a file this app does not have must be listed in TOOL-MAP's "Guides not included"
    const missing = new Set<string>();
    for (const f of guides()) {
      for (const m of readFileSync(f, "utf8").matchAll(/\b(?:(?:skills|schemas|styles|pipeline_defs|remotion-composer)\/[A-Za-z0-9_./-]*[A-Za-z0-9_]|AGENT_GUIDE\.md|PROJECT_CONTEXT\.md)/g)) {
        const p = m[0];
        if (![p, `${p}.md`, `${p}.yaml`].some((x) => existsSync(path.join(OM_REF, x)))) missing.add(p);
      }
    }
    const notIncluded = TOOL_MAP.slice(TOOL_MAP.indexOf("## Guides not included"));
    const listed = [...notIncluded.matchAll(/`([^`]+)`/g)].map((m) => m[1]!.replace(/\/\.\.\.$/, ""));
    expect([...missing].filter((p) => !listed.some((l) => p === l || p.startsWith(`${l}/`)))).toEqual([]);
  });

  it("every_tool_name_in_the_guides_is_mapped", () => {
    const names = new Set<string>();
    for (const f of guides()) {
      for (const m of readFileSync(f, "utf8").matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)*_(?:selector|gen|compose|validator|check|tts|search|render|risk|energy|tracker|mixer|stitch|probe|bundle)\b/g)) names.add(m[0]);
    }
    expect(names.size).toBeGreaterThan(10);
    expect([...names].filter((n) => !TOOL_MAP.includes(`\`${n}\``))).toEqual([]);
  });

  it("draw_objects_skill_covers_any_object_and_the_rules", () => {
    const t = readFileSync("engine-kit/skills/draw-objects/SKILL.md", "utf8");
    expect(t).toMatch(/any object/i);
    expect(t).toMatch(/<svg/);
    expect(t).toContain("ref/openmontage/themes/");
    expect(t).toContain("preview_frames");
    expect(t).toContain("vidtsx-2d-generator"); // the crash and flicker rules live there
    expect(t).toMatch(/no remote images/i);
    expect(t).toMatch(/no emoji/i);
    expect(t).toMatch(/2D/);
    expect(t).toMatch(/frame 0/i); // the final render refuses an empty first frame
    expect(t).toContain("check_frames");
  });

  it("entry_skill_steers_explainers_to_way_2", () => {
    const t = readFileSync("engine-kit/skills/openmontage-pipeline/SKILL.md", "utf8");
    expect(t).toMatch(/Explainer[^\n]*(bespoke|drawn)/i);
    expect(t).toContain("draw-objects");
    expect(TOOL_MAP).toContain("draw-objects");
  });

  it("themes_are_seeded_for_drawing", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "kit-themes-"));
    try {
      const ws = await prepareWorkspace(root, "0190f3a2-7c1e-7a55-9d3b-2f6c8a1b4e92", engineKitSeeds(process.cwd()));
      expect(JSON.parse(readFileSync(path.join(ws.workDir, "ref/openmontage/themes/flat-motion-graphics.json"), "utf8"))).toMatchObject({ primaryColor: "#7C3AED" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("entry_skill_overrides_commands", () => {
    const t = readFileSync("engine-kit/skills/openmontage-pipeline/SKILL.md", "utf8");
    expect(t).toMatch(/TOOL-MAP/);
    expect(t).toMatch(/never run/i);
    expect(TOOL_MAP).toMatch(/never run any command a guide shows/i);
    for (const tool of ["check_code", "preview_frames", "check_frames", "check_scenes", "preview_scenes", "list_assets", "fetch_asset"]) {
      expect(TOOL_MAP).toContain(tool);
      expect(t).toContain(tool);
    }
  });

  it("examples_are_not_under_remotion_kit (reference only, never rendered by the app)", () => {
    expect(existsSync("engine-kit/examples/short-13/composition/Short13BinSearch.tsx")).toBe(true);
    expect(existsSync("remotion/kit/examples")).toBe(false);
  });

  it("default_seeds_copy_engine_kit", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "kit-seeds-"));
    try {
      const ws = await prepareWorkspace(root, "0190f3a2-7c1e-7a55-9d3b-2f6c8a1b4e91", engineKitSeeds(process.cwd()));
      expect(existsSync(path.join(ws.workDir, ".claude/skills/make-short/SKILL.md"))).toBe(true);
      expect(existsSync(path.join(ws.workDir, "ref/brand/brand.md"))).toBe(true);
      expect(existsSync(path.join(ws.workDir, "ref/examples/short-14/script.md"))).toBe(true);
      expect(readFileSync(path.join(ws.workDir, "ref/lib/index.md"), "utf8")).toMatch(/## yt-old\/shorts/);
      expect(existsSync(path.join(ws.workDir, ".claude/skills/make-vox"))).toBe(false); // later skills are not seeded yet
      // OpenMontage's guides keep their own layout, so the directors' internal paths work under ref/openmontage/
      for (const f of ["pipeline_defs/animated-explainer.yaml", "pipeline_defs/animation.yaml", "skills/pipelines/explainer/executive-producer.md", "skills/meta/reviewer.md", "schemas/artifacts/scene_plan.schema.json", "styles/flat-motion-graphics.yaml"]) {
        expect(existsSync(path.join(ws.workDir, "ref/openmontage", f)), f).toBe(true);
      }
      expect(existsSync(path.join(ws.workDir, "ref/openmontage/MANIFEST.json"))).toBe(false); // only ref/ is seeded
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
