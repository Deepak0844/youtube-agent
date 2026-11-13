import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { engineTools, safeWorkPath, type EngineToolDeps } from "@/server/engine/mcp/tools";
import { ToolMessage, type McpTool } from "@/server/engine/mcp/protocol";

// The engine tools Claude may call in a build run (ADR 0015). Every path stays inside work/; every render happens through the
// injected stills function (the locked container in production); assets come only from the app's registry.

let work: string;
let outside: string;
beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), "eng-work-"));
  outside = await mkdtemp(path.join(tmpdir(), "eng-out-"));
  await writeFile(path.join(outside, "secret.txt"), "SECRET");
  await mkdir(path.join(work, "scene"));
  await writeFile(path.join(work, "scene", "video.tsx"), "export const meta = { durationInFrames: 60 };");
});
afterEach(async () => {
  await rm(work, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

const PNG = Buffer.from("89504e470d0a1a0a", "hex");
function deps(over: Partial<EngineToolDeps> = {}): EngineToolDeps {
  return {
    workDir: work,
    check: async () => ({ ok: true, problems: [] }),
    stills: async (_src, frames) => {
      const files = [];
      for (const f of frames) {
        const p = path.join(outside, `still-${f}.png`);
        await writeFile(p, PNG);
        files.push(p);
      }
      return { ok: true, files, frameCount: 60 };
    },
    listAssets: async () => [{ id: "a1", kind: "sfx", name: "whoosh", licence: "CC0", durationS: 1.2 }],
    assetFile: async (id) => (id === "a1" ? path.join(outside, "whoosh.wav") : null),
    probeDuration: async (file) => (file.endsWith(".wav") ? 18 : null),
    ...over,
  };
}
const tool = (d: EngineToolDeps, name: string): McpTool => engineTools(d).find((t) => t.name === name)!;

describe("safeWorkPath", () => {
  it("allows plain relative paths inside work", () => {
    expect(safeWorkPath(work, "scene/video.tsx")).toBe(path.join(work, "scene", "video.tsx"));
  });
  it("refuses absolute, parent, empty and NUL paths", () => {
    for (const bad of ["/etc/hosts", "../secret.txt", "scene/../../x", "", "a\u0000b", "ref/../.."]) expect(safeWorkPath(work, bad), bad).toBeNull();
  });
});

describe("engine tools", () => {
  it("lists exactly the five tools with closed schemas", () => {
    const ts = engineTools(deps());
    expect(ts.map((t) => t.name)).toEqual(["check_code", "preview_frames", "check_scenes", "list_assets", "fetch_asset"]);
    for (const t of ts) expect(t.inputSchema.additionalProperties, t.name).toBe(false);
  });

  it("check_code reports problems as plain text", async () => {
    const out = await tool(deps({ check: async () => ({ ok: false, problems: ["Line 3: import of 'fs' is not allowed."] }) }), "check_code").run({ file: "scene/video.tsx" });
    expect(out).toEqual([{ type: "text", text: "Problems:\n- Line 3: import of 'fs' is not allowed." }]);
    expect(await tool(deps(), "check_code").run({ file: "scene/video.tsx" })).toEqual([{ type: "text", text: "The code passed the checks." }]);
  });

  it("refuses a path outside work and a link pointing out", async () => {
    await symlink(path.join(outside, "secret.txt"), path.join(work, "leak.tsx"));
    for (const file of ["../x.tsx", "leak.tsx", "/etc/hosts"]) {
      await expect(tool(deps(), "check_code").run({ file }), file).rejects.toBeInstanceOf(ToolMessage);
    }
  });

  it("preview_frames returns pictures and refuses more than 8, duplicates or non-integers", async () => {
    const out = await tool(deps(), "preview_frames").run({ file: "scene/video.tsx", frames: [0, 30] });
    expect(out.filter((c) => c.type === "image")).toHaveLength(2);
    expect(out[0]).toMatchObject({ type: "image", mimeType: "image/png", data: PNG.toString("base64") });
    for (const frames of [[0, 1, 2, 3, 4, 5, 6, 7, 8], [3, 3], [1.5], [], [-1]]) {
      await expect(tool(deps(), "preview_frames").run({ file: "scene/video.tsx", frames }), JSON.stringify(frames)).rejects.toBeInstanceOf(ToolMessage);
    }
  });

  it("preview_frames passes the renderer's plain failure back", async () => {
    const d = deps({ stills: async () => ({ ok: false, message: "The scene file has type errors.", problems: ["line 3: x"] }) });
    await expect(tool(d, "preview_frames").run({ file: "scene/video.tsx", frames: [0] })).rejects.toThrow("The scene file has type errors.\n- line 3: x");
  });

  it("list_assets returns the registry's list as text", async () => {
    const out = await tool(deps(), "list_assets").run({ kind: "sfx" });
    expect(JSON.parse((out[0] as { text: string }).text)).toEqual([{ id: "a1", kind: "sfx", name: "whoosh", licence: "CC0", durationS: 1.2 }]);
    await expect(tool(deps(), "list_assets").run({ kind: "secrets" })).rejects.toBeInstanceOf(ToolMessage);
  });

  it("fetch_asset copies a registered asset into work/assets only", async () => {
    await writeFile(path.join(outside, "whoosh.wav"), "RIFF");
    const out = await tool(deps(), "fetch_asset").run({ id: "a1", name: "whoosh.wav" });
    expect(await readFile(path.join(work, "assets", "whoosh.wav"), "utf8")).toBe("RIFF");
    expect((out[0] as { text: string }).text).toBe("Copied to assets/whoosh.wav.");
    await expect(tool(deps(), "fetch_asset").run({ id: "nope", name: "x.wav" })).rejects.toBeInstanceOf(ToolMessage);
    await expect(tool(deps(), "fetch_asset").run({ id: "a1", name: "../x.wav" })).rejects.toBeInstanceOf(ToolMessage);
  });
});

describe("check_scenes", () => {
  // OpenMontage keeps two files: the edit artifact (om/edit_decisions.json, strict schema: renderer_family, delivery promise in
  // metadata) and the composition the Explainer draws (om/composition.json: cuts with component types, overlays, audio, theme).
  const reel = JSON.parse(readFileSync("tests/fixtures/openmontage/animated-reel-20s.json", "utf8")) as { cuts: Array<Record<string, unknown>> };
  const shots = ["push_in", "static", "pan", "static"];
  const plan = { version: "1", scenes: reel.cuts.map((c, i) => ({ type: c.type, description: `scene ${i}`, narrative_role: "beat", shot_intent: "why", shot_language: { camera_movement: shots[i], shot_size: ["wide", "medium", "close", "wide"][i] } })) };
  const edit = (over: Record<string, unknown> = {}) => ({
    version: "1", render_runtime: "remotion", renderer_family: "explainer",
    cuts: reel.cuts.map((c) => ({ id: c.id, source: "", in_seconds: c.in_seconds, out_seconds: c.out_seconds })),
    metadata: { delivery_promise: { promise_type: "data_explainer", motion_required: false, tone_mode: "educational", quality_floor: "presentable" } },
    ...over,
  });
  const comp = (over: Record<string, unknown> = {}) => ({ ...reel, ...over });
  const put = async (rel: string, v: unknown) => {
    await mkdir(path.dirname(path.join(work, rel)), { recursive: true });
    await writeFile(path.join(work, rel), typeof v === "string" ? v : JSON.stringify(v));
  };
  const run = async (args: Record<string, unknown> = {}) => (await tool(deps(), "check_scenes").run(args)).map((c) => (c.type === "text" ? c.text : "")).join("\n");
  const verdict = (t: string) => t.trim().split("\n").at(-1);

  it("check_scenes_reports_all_checks", async () => {
    await put("om/composition.json", comp());
    await put("om/edit_decisions.json", edit());
    await put("om/scene_plan.json", plan);
    const t = await run();
    for (const h of ["Shape", "Assets and timing", "Slideshow risk", "Delivery promise"]) expect(t).toContain(`## ${h}`);
    expect(verdict(t)).toBe("VERDICT: pass");
  });

  it("check_scenes_names_a_missing_asset", async () => {
    await put("om/composition.json", comp({ cuts: [...reel.cuts, { id: "clip", source: "intro.mp4", in_seconds: 20, out_seconds: 22 }], audio: { narration: { src: "voice.wav" } } }));
    await put("om/edit_decisions.json", edit());
    await put("assets/voice.wav", "x");
    const t = await run();
    expect(t).toContain("Missing asset: intro.mp4 (looked in assets)");
    expect(t).toContain("Narration duration: 18.0s"); // probed through the injected probe, inside work/assets only
    expect(verdict(t)).toBe("VERDICT: fail");
  });

  it("check_scenes_blocks_like_openmontage_pre_compose", async () => {
    await put("om/composition.json", comp());
    await put("om/edit_decisions.json", edit({ renderer_family: undefined, metadata: { delivery_promise: { promise_type: "motion_led", motion_required: true } } }));
    const t = await run();
    expect(t).toContain("No renderer_family in edit_decisions.");
    expect(t).toContain("Delivery promise violation: Motion ratio 0% is below minimum 70% for motion_led.");
    expect(verdict(t)).toBe("VERDICT: fail");
  });

  it("check_scenes_without_an_edit_file_blocks_on_renderer_family", async () => {
    await put("om/composition.json", comp());
    const t = await run();
    expect(t).toContain("No renderer_family in edit_decisions.");
    expect(verdict(t)).toBe("VERDICT: fail");
  });

  it("fail_when_slideshow_verdict_is_fail", async () => {
    await put("om/composition.json", comp());
    await put("om/edit_decisions.json", edit({ renderer_family: "cinematic" })); // repeated text cards, no intent, cinematic claim without hero or lighting: 4.43
    await put("om/scene_plan.json", { version: "1", scenes: Array.from({ length: 5 }, () => ({ type: "text_card", description: "same", shot_language: { camera_movement: "pan", shot_size: "wide" } })) });
    const t = await run();
    expect(t).toMatch(/Slideshow risk score 4\.\d\/5\.0 \(verdict: fail\)/);
    expect(verdict(t)).toBe("VERDICT: fail");
  });

  it("check_scenes_refuses_paths_outside_work_and_links", async () => {
    await expect(run({ file: "../x.json" })).rejects.toThrow(ToolMessage);
    await expect(run({ file: path.join(outside, "secret.txt") })).rejects.toThrow(ToolMessage);
    await expect(run({ edit: "../x.json" })).rejects.toThrow(ToolMessage);
    await mkdir(path.join(work, "om"), { recursive: true });
    await symlink(path.join(outside, "secret.txt"), path.join(work, "om", "composition.json"));
    await expect(run()).rejects.toThrow(/Links are not allowed/);
    await rm(path.join(work, "om", "composition.json"));
    await put("om/composition.json", comp({ cuts: [{ id: "a", in_seconds: 0, out_seconds: 1, source: "../../secret.png" }] }));
    expect(await run()).toContain("Missing asset: ../../secret.png"); // an asset name never reaches outside work/assets
  });

  it("check_scenes_refuses_files_over_512_KB_and_bad_json", async () => {
    await put("om/composition.json", "x".repeat(513 * 1024));
    await expect(run()).rejects.toThrow(/512 KB/);
    await put("om/composition.json", "{nope");
    await expect(run()).rejects.toThrow(/not valid JSON/);
  });
});
