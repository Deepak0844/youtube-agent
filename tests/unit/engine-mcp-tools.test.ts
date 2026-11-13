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
  it("lists exactly the four tools with closed schemas", () => {
    const ts = engineTools(deps());
    expect(ts.map((t) => t.name)).toEqual(["check_code", "preview_frames", "list_assets", "fetch_asset"]);
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
