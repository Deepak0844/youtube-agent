import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkOmProps, omDurationFrames } from "@/server/providers/renderer/om-render";

// OpenMontage parity, Phase A: the keep-list, pin and patches stay consistent (npm run openmontage:sync relies on them), and
// the host's view of a scene list matches what OpenMontage's composition will draw.

const KIT = "engine-kit/openmontage";
const manifest = JSON.parse(readFileSync(path.join(KIT, "MANIFEST.json"), "utf8")) as { repo: string; files: Array<{ from: string; to: string }> };
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(path.join(dir, n)).isDirectory() ? walk(path.join(dir, n)) : [path.join(dir, n)]));
const reel = JSON.parse(readFileSync("tests/fixtures/openmontage/animated-reel-20s.json", "utf8")) as Record<string, unknown>;

describe("OpenMontage kit", () => {
  it("pins_an_exact_commit_of_the_official_repo", () => {
    const pin = JSON.parse(readFileSync(path.join(KIT, "UPSTREAM.json"), "utf8")) as { repo: string; commit: string; date: string };
    expect(pin.repo).toBe("https://github.com/calesthio/OpenMontage");
    expect(manifest.repo).toBe(pin.repo);
    expect(pin.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(Number.isNaN(Date.parse(pin.date))).toBe(false);
  });

  it("every_keep_list_file_is_present_and_nothing_else_is_in_the_composer_folder", () => {
    for (const f of manifest.files) expect(existsSync(f.to), f.to).toBe(true);
    const listed = new Set(manifest.files.map((f) => f.to));
    expect(walk("remotion/kit/om").map((f) => f.split(path.sep).join("/")).filter((f) => !listed.has(f))).toEqual([]);
    expect(new Set(manifest.files.map((f) => f.to)).size).toBe(manifest.files.length);
  });

  it("every_patch_targets_a_keep_list_text_file", () => {
    const listed = new Set(manifest.files.map((f) => f.to.replace(/\//g, "__") + ".patch"));
    for (const p of readdirSync(path.join(KIT, "patches"))) {
      expect(listed.has(p), p).toBe(true);
      const body = readFileSync(path.join(KIT, "patches", p), "utf8");
      const to = p.replace(/\.patch$/, "").replace(/__/g, "/");
      expect(body.startsWith(`--- a/${to}\n+++ b/${to}\n`), p).toBe(true);
    }
  });

  it("left_out_components_are_not_reachable", () => {
    const code = walk("remotion/kit/om").filter((f) => /\.tsx?$/.test(f)).map((f) => readFileSync(f, "utf8")).join("\n");
    for (const name of ["AnimeScene", "ScreenshotScene", "ProviderChip", "CinematicRenderer", "TalkingHead", "CollageBurst", "LyricOverlay", "TitledVideo", "ProductReveal", "EndTag"]) {
      expect(code, name).not.toMatch(new RegExp(`from "[^"]*${name}"`));
    }
  });

  it("assets_resolve_only_to_staged_file_names", async () => {
    const { resolveAsset } = await import("../../remotion/kit/om/lib/resolveAsset");
    expect(resolveAsset("images/a.png")).toMatch(/images\/a\.png$/);
    expect(resolveAsset("./voice.mp3")).toMatch(/voice\.mp3$/);
    for (const bad of ["https://x.test/a.png", "http://x/a.mp3", "data:image/png;base64,AA", "file:///etc/passwd", "/etc/passwd", "C:\\x.png", "../a.png", "a/../../b.png", ""]) {
      expect(() => resolveAsset(bad), bad).toThrow(/not a staged file name/);
    }
  });
});

describe("OpenMontage scene lists on the host", () => {
  it("length_matches_the_composition_rule", () => {
    expect(omDurationFrames(reel)).toBe(630); // (20 s last out + 1 s tail) * 30
    expect(omDurationFrames({ ...reel, tailPaddingSeconds: 0 })).toBe(600);
    expect(omDurationFrames({ cuts: [] })).toBe(1800);
  });

  it("the_demo_reel_is_usable", () => {
    expect(checkOmProps(reel)).toEqual([]);
  });

  it("refuses_unusable_scene_lists", () => {
    expect(checkOmProps([])).toEqual(["The scene list is not a JSON object."]);
    expect(checkOmProps({ cuts: [] })).toEqual(["The scene list has no cuts."]);
    expect(checkOmProps({ cuts: [{ id: "a", type: "text_card", in_seconds: 3, out_seconds: 2 }] })).toEqual(["Cut 0 needs 0 <= in_seconds < out_seconds."]);
    expect(checkOmProps({ cuts: [{ type: "text_card", in_seconds: 0, out_seconds: 2 }] })).toEqual(["Cut 0 needs an id and a type or source."]);
    expect(checkOmProps({ cuts: [{ id: "a", type: "text_card", in_seconds: 0, out_seconds: 13 * 60 }] })).toEqual(["The video is longer than 12 minutes."]);
    expect(checkOmProps({ cuts: [{ id: "a", type: "text_card", in_seconds: 0, out_seconds: 2, text: "x".repeat(600_000) }] })).toContain("The scene list is bigger than 512 KB.");
  });
});
