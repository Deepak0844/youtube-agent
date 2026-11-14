// What OpenMontage does to a composition just before it renders (tools/video/video_compose.py _remotion_render and
// _build_theme_from_playbook's metadata fallback, AGPL-3.0, https://github.com/calesthio/OpenMontage): add the playbook's
// themeConfig, pass the caption look through, and find the media files the composer will load. OpenMontage copies those files
// into Remotion's public folder; here they must already be in the run's assets/ (the renderer stages exactly those names).
import { omThemeConfig } from "./theme";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {});
const MEDIA_KEYS = new Set(["source", "src", "backgroundSrc", "backgroundImage", "backgroundVideo", "images"]);

/** _build_theme_from_playbook's fallback: colours from the composition's metadata when no playbook loads. */
function themeFromMetadata(meta: Obj): Obj | null {
  if (!meta.primary_color) return null;
  return {
    primaryColor: meta.primary_color,
    accentColor: meta.accent_color ?? "#F59E0B",
    backgroundColor: meta.background_color ?? "#FFFFFF",
    surfaceColor: meta.surface_color ?? "#F9FAFB",
    textColor: meta.text_color ?? "#1F2937",
    mutedTextColor: "#6B7280",
    headingFont: meta.heading_font ?? "Inter",
    bodyFont: meta.body_font ?? "Inter",
    monoFont: "JetBrains Mono",
    chartColors: meta.chart_colors ?? ["#2563EB", "#F59E0B", "#10B981"],
    springConfig: { damping: 20, stiffness: 120, mass: 1 },
    transitionDuration: 0.4,
    captionHighlightColor: meta.primary_color,
    captionBackgroundColor: "rgba(255, 255, 255, 0.85)",
  };
}

/** Every media file name the composer would load (remote and data: URLs are left out: the render box refuses them). */
function mediaNames(node: unknown, key: string | null, out: Set<string>): void {
  if (Array.isArray(node)) for (const v of node) mediaNames(v, key, out);
  else if (typeof node === "object" && node !== null) for (const [k, v] of Object.entries(node)) mediaNames(v, k, out);
  else if (typeof node === "string" && node && key !== null && MEDIA_KEYS.has(key) && !/^(https?:|data:)/i.test(node)) out.add(node);
}

export function composeOmProps(composition: Obj, editDecisions?: Obj | null): { props: Obj; assetNames: string[] } {
  const props = structuredClone(composition);
  if (!Object.hasOwn(props, "themeConfig")) {
    const name = props.playbook || props.theme || obj(props.metadata).playbook;
    const theme = (typeof name === "string" ? omThemeConfig(name) : null) ?? themeFromMetadata(obj(props.metadata));
    if (theme) props.themeConfig = theme;
  }
  const captionProps = obj(props.subtitles).caption_props ?? obj(obj(editDecisions).subtitles).caption_props;
  if (typeof captionProps === "object" && captionProps !== null && !Array.isArray(captionProps)) props.captionProps = captionProps;
  const names = new Set<string>();
  mediaNames(props, null, names);
  return { props, assetNames: [...names] };
}
