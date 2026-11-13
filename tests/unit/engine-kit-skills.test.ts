import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { engineKitSeeds, prepareWorkspace } from "@/server/engine/workspace";

// The engine's seeds (old-kit-import): skills rewritten for the engine's tools, the old shorts as read-only examples, and the
// library index, copied into every run.

const skills = readdirSync("engine-kit/skills").map((d) => path.join("engine-kit/skills", d, "SKILL.md"));

describe("engine-kit seeds", () => {
  it("skills_mention_only_engine_tools", () => {
    expect(skills.length).toBe(3);
    for (const f of skills) {
      const t = readFileSync(f, "utf8");
      expect(t, f).not.toMatch(/\bpython3?\b|\bnpm\b|node (remotion|scripts)|Bash\(|tools\/[a-z_]+\.py|ElevenLabs/);
      expect(t, f).toMatch(/^---\nname: [a-z0-9-]+\ndescription: /);
    }
    expect(readFileSync("engine-kit/skills/make-short/SKILL.md", "utf8")).toMatch(/preview_frames[\s\S]*check_code|check_code[\s\S]*preview_frames/);
  });

  it.todo("every_path_a_guide_names_is_seeded_or_mapped");

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
