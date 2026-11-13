import { copyFile, lstat, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { TSX_MAX_BYTES } from "@/server/core/tsx-check";
import { checkScenes, referencedAssets } from "@/server/engine/om-checks";
import { ToolMessage, type McpContent, type McpTool } from "./protocol";

// The engine tools of a build run (ADR 0015). Paths are relative to work/ and checked (no absolute, no "..", no link
// anywhere on the way). Rendering goes only through `stills` (the locked render container in production); assets come only
// from the app's registry. Plain sentences only: a ToolMessage is shown to Claude, anything else becomes a fixed sentence.

export const ASSET_KINDS = ["sfx", "music", "image", "video"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];
export interface EngineToolDeps {
  workDir: string;
  /** Safety check + type-check of a scene file (no running). */
  check(source: string): Promise<{ ok: boolean; problems: string[] }>;
  /** Draws the given frames in the locked render container; files are PNGs outside work/. */
  stills(source: string, frames: number[]): Promise<{ ok: true; files: string[]; frameCount: number } | { ok: false; message: string; problems: string[] }>;
  listAssets(kind: AssetKind, query?: string): Promise<Array<{ id: string; kind: AssetKind; name: string; licence: string; durationS?: number }>>;
  /** The stored file of a registered asset, or null. */
  assetFile(id: string): Promise<string | null>;
  /** Length in seconds of an audio or video file inside work/assets (ffprobe), or null when it cannot be read. */
  probeDuration(file: string): Promise<number | null>;
}

const MAX_FRAMES = 8;
const MAX_IMAGE_BYTES = 3_500_000;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.(wav|mp3|m4a|ogg|png|jpg|jpeg|webp|svg|mp4|webm)$/;

/** The absolute path of `rel` inside workDir, or null when it is absolute, climbs out, is empty or has a NUL. */
export function safeWorkPath(workDir: string, rel: string): string | null {
  if (typeof rel !== "string" || rel === "" || rel.includes("\u0000") || path.isAbsolute(rel)) return null;
  const full = path.resolve(workDir, rel);
  return full.startsWith(workDir + path.sep) ? full : null;
}

/** Refuses a path whose file or any folder on the way (inside work/) is a link. */
async function noLinks(workDir: string, full: string): Promise<void> {
  for (let p = full; p.startsWith(workDir + path.sep); p = path.dirname(p)) {
    const st = await lstat(p).catch(() => null);
    if (st?.isSymbolicLink()) throw new ToolMessage("Links are not allowed in the work folder.");
  }
}

async function readScene(d: EngineToolDeps, file: unknown): Promise<string> {
  const full = typeof file === "string" ? safeWorkPath(d.workDir, file) : null;
  if (!full) throw new ToolMessage("Give a file path inside the work folder, like scene/video.tsx.");
  await noLinks(d.workDir, full);
  const st = await lstat(full).catch(() => null);
  if (!st?.isFile()) throw new ToolMessage(`There is no file ${String(file)} in the work folder.`);
  if (st.size > TSX_MAX_BYTES) throw new ToolMessage(`The file is over ${TSX_MAX_BYTES / 1024} KB. Make it smaller.`);
  return readFile(full, "utf8");
}

const MAX_JSON_BYTES = 512 * 1024;

/** A JSON artifact in the work folder (om/...): inside work, no links, at most 512 KB, an object. Missing = null when optional. */
async function readJson(d: EngineToolDeps, rel: string, optional: boolean): Promise<Record<string, unknown> | null> {
  const full = safeWorkPath(d.workDir, rel);
  if (!full) throw new ToolMessage("Give a file path inside the work folder, like om/composition.json.");
  await noLinks(d.workDir, full);
  const st = await lstat(full).catch(() => null);
  if (!st?.isFile()) {
    if (optional) return null;
    throw new ToolMessage(`There is no file ${rel} in the work folder.`);
  }
  if (st.size > MAX_JSON_BYTES) throw new ToolMessage(`${rel} is over 512 KB. Make it smaller.`);
  let v: unknown;
  try {
    v = JSON.parse(await readFile(full, "utf8"));
  } catch {
    throw new ToolMessage(`${rel} is not valid JSON.`);
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ToolMessage(`${rel} must hold a JSON object.`);
  return v as Record<string, unknown>;
}

const obj = (a: unknown): Record<string, unknown> => (typeof a === "object" && a !== null && !Array.isArray(a) ? (a as Record<string, unknown>) : {});

export function engineTools(d: EngineToolDeps): McpTool[] {
  return [
    {
      name: "check_code",
      description: "Safety-check and type-check a scene file in the work folder (nothing is run). Use before preview_frames.",
      inputSchema: { type: "object", properties: { file: { type: "string", description: "Path inside the work folder, e.g. scene/video.tsx" } }, required: ["file"], additionalProperties: false },
      run: async (a) => {
        const r = await d.check(await readScene(d, obj(a).file));
        return [{ type: "text", text: r.ok ? "The code passed the checks." : `Problems:\n${r.problems.slice(0, 20).map((p) => `- ${p}`).join("\n")}` }];
      },
    },
    {
      name: "preview_frames",
      description: `Draw up to ${MAX_FRAMES} frames of a scene file as pictures (in the locked renderer) so you can look at them.`,
      inputSchema: {
        type: "object",
        properties: { file: { type: "string" }, frames: { type: "array", items: { type: "integer", minimum: 0 }, minItems: 1, maxItems: MAX_FRAMES } },
        required: ["file", "frames"],
        additionalProperties: false,
      },
      run: async (a) => {
        const { file, frames } = obj(a);
        if (!Array.isArray(frames) || frames.length < 1 || frames.length > MAX_FRAMES || !frames.every((f) => Number.isInteger(f) && f >= 0) || new Set(frames).size !== frames.length) {
          throw new ToolMessage(`Ask for 1 to ${MAX_FRAMES} different whole frame numbers, 0 or more.`);
        }
        const r = await d.stills(await readScene(d, file), frames as number[]);
        if (!r.ok) throw new ToolMessage([r.message, ...r.problems.slice(0, 10).map((p) => `- ${p}`)].join("\n"));
        const out: McpContent[] = [];
        for (const [i, f] of r.files.entries()) {
          const bytes = await readFile(f);
          if (bytes.length > MAX_IMAGE_BYTES) out.push({ type: "text", text: `Frame ${frames[i]} is too big to show.` });
          else out.push({ type: "image", data: bytes.toString("base64"), mimeType: "image/png" });
        }
        out.push({ type: "text", text: `Frames ${(frames as number[]).join(", ")} of ${r.frameCount}.` });
        return out;
      },
    },
    {
      name: "check_scenes",
      description:
        "Run OpenMontage's pre-render checks: the composition (om/composition.json: shape, staged assets, audio length) and the edit (om/edit_decisions.json: slideshow risk, delivery promise, renderer_family). Ends with VERDICT: pass, revise or fail.",
      inputSchema: {
        type: "object",
        properties: {
          file: { type: "string", description: "The composition the Explainer draws. Default om/composition.json" },
          edit: { type: "string", description: "Default om/edit_decisions.json (optional file)" },
          plan: { type: "string", description: "Default om/scene_plan.json (optional file)" },
          brief: { type: "string", description: "Default om/proposal_packet.json (optional file)" },
        },
        additionalProperties: false,
      },
      run: async (a) => {
        const { file, edit: editFile, plan, brief } = obj(a);
        const rel = (v: unknown, def: string) => (v === undefined ? def : typeof v === "string" ? v : "");
        const composition = (await readJson(d, rel(file, "om/composition.json"), false))!;
        const editDecisions = await readJson(d, rel(editFile, "om/edit_decisions.json"), true);
        const scenePlan = await readJson(d, rel(plan, "om/scene_plan.json"), true);
        const proposal = await readJson(d, rel(brief, "om/proposal_packet.json"), true);
        // Asset names resolve inside work/assets only; a name that climbs out or passes a link is simply missing.
        const assetsDir = path.join(d.workDir, "assets");
        const found = new Map<string, number | null>();
        for (const name of referencedAssets(composition)) {
          const full = safeWorkPath(assetsDir, name);
          if (!full) continue;
          const linked = await noLinks(d.workDir, full).then(() => false, () => true);
          const st = linked ? null : await lstat(full).catch(() => null);
          if (!st?.isFile()) continue;
          found.set(name, /\.(wav|mp3|m4a|aac|flac|ogg|mp4|webm|mov)$/i.test(name) ? await d.probeDuration(full).catch(() => null) : null);
        }
        const r = checkScenes({ composition, editDecisions, scenePlan, proposal, files: { exists: (n) => found.has(n), durationS: (n) => found.get(n) ?? null } });
        return [{ type: "text", text: r.report }];
      },
    },
    {
      name: "list_assets",
      description: "List library items you may use: sound effects, music, images or video clips (all licence-checked).",
      inputSchema: { type: "object", properties: { kind: { type: "string", enum: [...ASSET_KINDS] }, query: { type: "string", maxLength: 80 } }, required: ["kind"], additionalProperties: false },
      run: async (a) => {
        const { kind, query } = obj(a);
        if (!(ASSET_KINDS as readonly string[]).includes(String(kind))) throw new ToolMessage(`kind must be one of ${ASSET_KINDS.join(", ")}.`);
        const items = await d.listAssets(kind as AssetKind, typeof query === "string" ? query.slice(0, 80) : undefined);
        return [{ type: "text", text: JSON.stringify(items.slice(0, 50)) }];
      },
    },
    {
      name: "fetch_asset",
      description: "Copy a library item (by id from list_assets) into the work folder's assets/ so the scene can use it.",
      inputSchema: { type: "object", properties: { id: { type: "string", maxLength: 80 }, name: { type: "string", description: "File name to use, e.g. whoosh.wav" } }, required: ["id", "name"], additionalProperties: false },
      run: async (a) => {
        const { id, name } = obj(a);
        if (typeof name !== "string" || !NAME.test(name)) throw new ToolMessage("Give a plain file name with a media extension, like whoosh.wav.");
        const src = typeof id === "string" ? await d.assetFile(id) : null;
        if (!src) throw new ToolMessage("There is no library item with that id. Use list_assets first.");
        const dir = path.join(d.workDir, "assets");
        await noLinks(d.workDir, dir);
        await mkdir(dir, { recursive: true });
        const dest = path.join(dir, name);
        await noLinks(d.workDir, dest);
        await copyFile(src, dest);
        return [{ type: "text", text: `Copied to assets/${name}.` }];
      },
    },
  ];
}
