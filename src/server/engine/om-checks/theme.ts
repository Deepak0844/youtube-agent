// Port of OpenMontage tools/video/video_compose.py VideoCompose._build_theme_from_playbook (playbook branch; AGPL-3.0,
// https://github.com/calesthio/OpenMontage) at the commit in engine-kit/openmontage/UPSTREAM.json: the Remotion themeConfig a
// style playbook gives (colours, fonts, chart colours, captions, spring). The sync command pre-computes one file per style in
// engine-kit/openmontage/ref/themes/, so the app never parses YAML at run time. Proven equal on goldens/theme-*.json.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {});
const has = (o: Obj, k: string) => Object.hasOwn(o, k);
const get = (o: Obj, k: string, fallback: unknown) => (has(o, k) ? o[k] : fallback);
const first = (v: unknown) => (Array.isArray(v) ? v[0] : v);

export const OM_THEMES_DIR = fileURLToPath(new URL("../../../../engine-kit/openmontage/ref/themes/", import.meta.url));

export function themeFromPlaybook(playbook: Obj): Obj | null {
  if (Object.keys(playbook).length === 0) return null;
  const palette = obj(obj(playbook.visual_language).color_palette);
  const typo = obj(playbook.typography);
  const primary = first(get(palette, "primary", ["#2563EB"]));
  const accent = first(get(palette, "accent", ["#F59E0B"]));
  const bg = get(palette, "background", "#FFFFFF") as string;
  const text = get(palette, "text", "#1F2937");
  const surface = get(palette, "surface", bg);
  const muted = get(palette, "muted", "#6B7280");

  const own = (palette.chart_palette as unknown) || playbook.chart_palette || [];
  let chart = (Array.isArray(own) ? own : []).filter((c): c is string => typeof c === "string");
  if (chart.length < 3) {
    chart = [];
    for (const k of ["primary", "accent", "secondary", "success", "warning", "info"]) {
      const v = palette[k];
      if (v) chart.push(first(v) as string);
    }
  }
  if (chart.length < 3) chart = [primary as string, accent as string, "#10B981", "#8B5CF6", "#EC4899", "#06B6D4"];

  const theme: Obj = {
    primaryColor: primary,
    accentColor: accent,
    backgroundColor: bg,
    surfaceColor: surface,
    textColor: text,
    mutedTextColor: muted,
    headingFont: get(obj(get(typo, "headings", {})), "font", "Inter"),
    bodyFont: get(obj(get(typo, "body", {})), "font", "Inter"),
    monoFont: get(obj(get(typo, "code", {})), "font", "JetBrains Mono"),
    chartColors: chart.slice(0, 6),
    springConfig: { damping: 20, stiffness: 120, mass: 1 },
    transitionDuration: 0.4,
  };
  theme.captionHighlightColor = primary;
  theme.captionBackgroundColor = ["#FFFFFF", "#FAFAFA", "#F9FAFB"].includes(String(bg).toUpperCase()) ? "rgba(255, 255, 255, 0.85)" : "rgba(15, 23, 42, 0.75)";
  const pace = get(obj(get(playbook, "identity", {})), "pace", "moderate");
  if (pace === "fast") {
    theme.springConfig = { damping: 12, stiffness: 80, mass: 1 };
    theme.transitionDuration = 0.3;
  } else if (pace === "slow") {
    theme.springConfig = { damping: 25, stiffness: 150, mass: 1 };
    theme.transitionDuration = 0.6;
  }
  return theme;
}

/** The pre-computed themeConfig of a style playbook by name, or null for an unknown or malformed name (never a path). */
export function omThemeConfig(name: string, dir: string = OM_THEMES_DIR): Obj | null {
  if (typeof name !== "string" || !/^[a-z0-9-]{1,40}$/.test(name)) return null;
  const file = path.join(dir, `${name}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as Obj;
}
