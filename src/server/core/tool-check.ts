// The tools a video needs on this computer (the old app's "doctor"): ffmpeg and ffprobe (sound, captions, QA, joining), Docker (the render
// container) and the render image itself. Pure: no IO. The runner is src/server/render/tool-check.ts.

export type ToolId = "ffmpeg" | "ffprobe" | "docker" | "render_image";
export interface ToolCheck {
  id: ToolId;
  label: string;
  ok: boolean;
  /** one plain line: the version when it works, why not when it does not. Never a path or an error dump. */
  detail: string;
  /** what to do, when it does not work */
  fix: string | null;
}

export const TOOL_IDS: readonly ToolId[] = ["ffmpeg", "ffprobe", "docker", "render_image"];
export const TOOL_LABELS: Readonly<Record<ToolId, string>> = { ffmpeg: "ffmpeg", ffprobe: "ffprobe", docker: "Docker", render_image: "Render image" };
const FIX: Readonly<Record<ToolId, string>> = {
  ffmpeg: "Install ffmpeg (on a Mac: brew install ffmpeg), then check again.",
  ffprobe: "Install ffmpeg, which includes ffprobe (on a Mac: brew install ffmpeg), then check again.",
  docker: "Start OrbStack (or Docker) and check again. Videos cannot be drawn without it.",
  render_image: "Build the render image: npm run image:render. Videos cannot be drawn without it.",
};

/** "7.1.1" from the first line of `ffmpeg -version` / `ffprobe -version`, or null when it does not look like one. */
export function ffVersion(output: string, tool: "ffmpeg" | "ffprobe"): string | null {
  const m = new RegExp(`^${tool} version (\\S{1,40})`, "m").exec(output);
  return m ? m[1]! : null;
}

/** "27.1.0" style, from `docker info --format {{.ServerVersion}}`. Anything else is not trusted. */
export function dockerVersion(output: string): string | null {
  const v = output.trim();
  return /^[0-9][0-9A-Za-z.+_-]{0,30}$/.test(v) ? v : null;
}

export const okCheck = (id: ToolId, detail: string): ToolCheck => ({ id, label: TOOL_LABELS[id], ok: true, detail, fix: null });
export const badCheck = (id: ToolId, detail: string): ToolCheck => ({ id, label: TOOL_LABELS[id], ok: false, detail, fix: FIX[id] });

export function toolsSummary(checks: readonly ToolCheck[]): { ok: boolean; line: string } {
  const bad = checks.filter((c) => !c.ok);
  if (bad.length === 0) return { ok: true, line: `All ${checks.length} tools are ready.` };
  return { ok: false, line: `${bad.length} of ${checks.length} tools need attention: ${bad.map((c) => c.label).join(", ")}.` };
}
