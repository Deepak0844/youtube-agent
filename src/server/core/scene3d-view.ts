import { z } from "zod";
import { missingAssetSchema, type MissingAsset } from "@/server/core/scene3d-direct";
import { readPreviews, type PreviewsBody } from "@/server/core/scene3d-stills";
import { scene3dSchema, shotBeatId } from "@/shared/scene3d";

// Plain-words views of a 3D story (scene3d) video. Pure: no IO, no WebGL.

export const SCENE3D_NATIVE_SETTING = "render.native_3d";
export const SCENE3D_ENSURE_COMMAND = "npx remotion browser ensure";

/**
 * The note on the New video form: null when this Mac can render 3D stories, otherwise one plain sentence that leads with the fix and
 * names the setting and the command. Read only: it never turns the setting on.
 */
export function scene3dNativeNote(native3d: boolean, preflight: { ready: boolean; message: string } | null): string | null {
  const fix = `Turn on "Render 3D on this Mac" (${SCENE3D_NATIVE_SETTING}) in System settings and run "${SCENE3D_ENSURE_COMMAND}" in the project folder once: 3D stories are drawn on this Mac only.`;
  if (!native3d) return `${fix} The setting is off now, so the long render would stop.`;
  if (preflight && !preflight.ready) return `${fix} This Mac is not ready: ${preflight.message}`.slice(0, 600);
  return null;
}

// ---- the Look: preview pictures with their captions, what could not be found, and the advisory notes -------------------

/** How many times the owner may send a Look back to the director. After that the choice is to approve it or cancel the video. */
export const LOOK_SEND_BACK_CAP = 3;

/** The plain refusal for a send-back past the cap, or null while one is still allowed. `used` = send-backs already made. */
export function lookSendBackProblem(used: number): string | null {
  return used >= LOOK_SEND_BACK_CAP
    ? `You have already sent this look back ${LOOK_SEND_BACK_CAP} times, which is the most the director is asked to redo. Approve this look, or cancel the video and start a new one with a clearer topic.`
    : null;
}

/** "12.5 s" for a time in the video. */
export const timeLabel = (s: number): string => `${Math.round(s * 10) / 10} s`;

export interface LookStill {
  /** Path in the video folder (stills/NN.png). */
  file: string;
  timeS: number;
  shot: string;
  caption: string | null;
}
export interface LookSummary {
  stills: LookStill[];
  /** What the director could not find in the catalogue, with what it used instead. */
  missing: MissingAsset[];
  advice: PreviewsBody["advice"];
}
export type LookView = { ok: true; look: LookSummary } | { ok: false; message: string };

export const LOOK_UNREADABLE = "The preview pictures are not readable. They are drawn after the narration is made; if this stays, run the preview step again.";

/** The stored `previews` body plus the `scenes` body (for its missing_assets) as what the Look card and the Preview tab show. */
export function lookView(previews: unknown, scenes: unknown): LookView {
  const p = readPreviews(previews);
  if (!p) return { ok: false, message: LOOK_UNREADABLE };
  const raw = typeof scenes === "object" && scenes !== null ? (scenes as { missing_assets?: unknown }).missing_assets : undefined;
  const missing = missingAssetSchema.array().max(40).safeParse(raw);
  return {
    ok: true,
    look: {
      stills: p.stills.map((s, i) => ({ file: s.file, timeS: p.times[i]!, shot: p.shots[i]!.id, caption: p.shots[i]!.caption })),
      missing: missing.success ? missing.data : [],
      advice: p.advice,
    },
  };
}

// ---- the storyboard summary for the Preview tab ----------------------------------------------------------------------

export interface Scene3dShotRow {
  n: number;
  id: string;
  startS: number;
  durationS: number;
  /** The story beat this shot belongs to and the one-sentence visual written for it, when the script has a story. */
  beat: string | null;
  visual: string | null;
  caption: string | null;
  /** Names of what the camera frames. */
  focus: string;
}
export interface Scene3dObjectRow {
  id: string;
  /** "Cargo Ship (pp_ship)" for a catalogue model, a plain word like "water" or "sand pile" for an engine block. */
  label: string;
  isModel: boolean;
}
export interface Scene3dSummary {
  shots: Scene3dShotRow[];
  objects: Scene3dObjectRow[];
  missing: MissingAsset[];
  totalS: number;
}
export type Scene3dSummaryView = { ok: true; summary: Scene3dSummary } | { ok: false; message: string };

export const SCENE3D_EMPTY = "No 3D scene yet. It appears once the director step has written it.";
export const SCENE3D_UNREADABLE = "The 3D scene is not readable. If this stays, run the director step again.";

const storyRowSchema = z.object({ id: z.string(), visual: z.string() });

/**
 * The stored `scenes` body of a scene3d video ({kind: "scene3d", scene, missing_assets}) and the script's story as the storyboard the owner
 * reads: every shot with its time and visual line, what is in the scene (catalogue names through `nameOf`), and what could not be found.
 */
export function scene3dSummary(scenes: unknown, story: unknown, nameOf: (catalogId: string) => string | null): Scene3dSummaryView {
  if (scenes === null || scenes === undefined) return { ok: false, message: SCENE3D_EMPTY };
  const raw = typeof scenes === "object" ? (scenes as { scene?: unknown; missing_assets?: unknown }) : {};
  const parsed = scene3dSchema.safeParse(raw.scene);
  if (!parsed.success) return { ok: false, message: SCENE3D_UNREADABLE };
  const scene = parsed.data;
  const beats = z.array(storyRowSchema).safeParse(story);
  const beatIds = beats.success ? beats.data.map((b) => b.id) : [];
  const label = (id: string): string => {
    const el = scene.elements.find((e) => e.id === id);
    if (!el) return id;
    return el.kind === "model" ? (("catalog" in el.model ? nameOf(el.model.catalog) : null) ?? el.id) : `${el.id} (${el.kind.replace(/_/g, " ")})`;
  };
  let t = 0;
  const shots = scene.shots.map((s, i): Scene3dShotRow => {
    const beat = beats.success ? shotBeatId(s.id, beatIds) : null;
    const row: Scene3dShotRow = {
      n: i + 1, id: s.id, startS: Math.round(t * 100) / 100, durationS: s.duration_s, beat,
      visual: beat === null || !beats.success ? null : (beats.data.find((b) => b.id === beat)?.visual ?? null),
      caption: s.caption ?? null,
      focus: s.focus === undefined ? "free camera" : [s.focus].flat().map(label).join(", "),
    };
    t += s.duration_s;
    return row;
  });
  const objects = scene.elements.map((e): Scene3dObjectRow =>
    e.kind === "model"
      ? { id: e.id, isModel: true, label: "catalog" in e.model ? `${nameOf(e.model.catalog) ?? e.model.catalog} (${e.model.catalog})` : e.id }
      : { id: e.id, isModel: false, label: e.kind.replace(/_/g, " ") },
  );
  const missing = missingAssetSchema.array().max(40).safeParse(raw.missing_assets);
  return { ok: true, summary: { shots, objects, missing: missing.success ? missing.data : [], totalS: Math.round(t * 100) / 100 } };
}
