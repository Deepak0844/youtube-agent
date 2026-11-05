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
