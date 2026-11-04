import { scale3dSceneSchema } from "@/shared/scale3d/schema";
import type { ScaleItem } from "./script-contract";

// Plain-words views of a 3D scale-comparison video: no WebGL, nothing but pure schemas.
/** Same number as SCALE3D_MIN_RENDER_TIMEOUT_S in the render stage; kept here so the page does not import worker code. */
export const SCALE3D_MIN_RENDER_S = 900;

export interface Scale3dSummary {
  beats: { n: number; startS: number; durationS: number; label: string; caption: string; focus: string; rangeLabel: string }[];
  objects: { id: string; label: string; kindWord: string; heightM: number; claimKind: "sourced" | "computed"; detail: string }[];
  totalS: number;
  loop: boolean;
}
export type Scale3dView = { ok: true; summary: Scale3dSummary } | { ok: false; message: string };

const num = (n: number) => String(Math.round(n * 100) / 100);

/** The stored `scenes` body of a scale3d video ({kind: "scale3d", scene}) as ordered beats and the object list. */
export function scale3dSummary(body: unknown): Scale3dView {
  const scene = typeof body === "object" && body !== null ? (body as { scene?: unknown }).scene : undefined;
  const r = scale3dSceneSchema.safeParse(scene);
  if (!r.success) return { ok: false, message: "The 3D scene is not readable. It is built after the script is approved; if this stays, run the Build step again." };
  const s = r.data;
  const label = (id: string) => s.objects.find((o) => o.id === id)?.label ?? id;
  let t = 0;
  const beats = s.beats.map((b, i) => {
    const row = { n: i + 1, startS: t, durationS: b.duration_s, label: b.label, caption: b.caption, focus: label(b.focus), rangeLabel: b.range_m ? `${num(b.range_m[0])} to ${num(b.range_m[1])} m` : "whole object" };
    t += b.duration_s;
    return row;
  });
  const objects = s.objects.map((o) => ({
    id: o.id,
    label: o.label,
    kindWord: o.kind.replace(/_/g, " "),
    heightM: o.height_m,
    claimKind: "method" in o.claim ? ("computed" as const) : ("sourced" as const),
    detail: "method" in o.claim ? o.claim.method : `${o.claim.source_url} - "${o.claim.quote}"`,
  }));
  return { ok: true, summary: { beats, objects, totalS: Math.round(t * 100) / 100, loop: s.loop_back } };
}

/** The script's `scale` list as rows the claim table can show: height first, then how it is backed. */
export function scaleRows(scale: readonly ScaleItem[] | undefined): { text: string; kind: "sourced" | "computed"; detail: string }[] {
  return (scale ?? []).map((o) => ({
    text: `${o.label} (${o.kind.replace(/_/g, " ")}): ${num(o.height_m)} m`,
    kind: o.method && !o.source_url ? "computed" : "sourced",
    detail: o.source_url ? `${o.source_url}${o.quote ? ` - "${o.quote}"` : ""}` : (o.method ?? "No source or method given"),
  }));
}

/** A plain note when the render time limit is too short for a 3D scale video; null when fine. Read only. */
export function renderLimitNote(timeoutS: number): string | null {
  return timeoutS >= SCALE3D_MIN_RENDER_S
    ? null
    : `A 3D scale video needs a render time limit of at least ${SCALE3D_MIN_RENDER_S} s. It is ${timeoutS} s now, so Render would refuse it. Raise "Render time limit, seconds" in Settings > System.`;
}
