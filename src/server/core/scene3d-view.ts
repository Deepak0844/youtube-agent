import { missingAssetSchema, type MissingAsset } from "@/server/core/scene3d-direct";
import { readPreviews, type PreviewsBody } from "@/server/core/scene3d-stills";

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
