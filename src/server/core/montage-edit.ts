// Montage M2 (pure, no IO): the ffmpeg arguments that turn picked stock clips into one film with ONE colour grade across mixed footage.
// Each clip is trimmed to its slot (from its middle, where stock clips are steadiest), cover-fitted to the frame (scaled up and centre-cropped, never
// stretched), set to 30 fps, graded, and joined with a short dip through black at the seams, and the film starts and ends on black so a looping Short has no jump (QA loop_seam). Total length = sum of the slot seconds exactly. Local only.

export const GRADES = {
  /** gentle contrast, slightly muted */
  film: "eq=contrast=1.06:saturation=0.88:gamma=0.98,colorbalance=rs=0.03:bs=-0.03",
  warm: "eq=contrast=1.04:saturation=1.05,colorbalance=rs=0.06:gs=0.01:bs=-0.06",
  cool: "eq=contrast=1.05:saturation=0.92,colorbalance=rs=-0.05:bs=0.06",
  mono: "hue=s=0,eq=contrast=1.1",
} as const;
export type GradeName = keyof typeof GRADES;

const FILE = /^[A-Za-z0-9_-]{1,40}\.mp4$/;
export const MONTAGE_FPS = 30;

export interface MontageClip {
  /** plain file name in the stage's own folder */
  file: string;
  /** the clip's own length */
  durationS: number;
  /** seconds this clip stays on screen */
  slotS: number;
}

export interface MontageEdit {
  clips: readonly MontageClip[];
  grade: GradeName;
  width: number;
  height: number;
  /** dip through black each side of a seam; 0 = hard cuts */
  fadeS: number;
  out: string;
}

/** A plain sentence saying what is wrong with the edit, or null. */
export function montageProblem(e: MontageEdit): string | null {
  if (e.clips.length < 1) return "There are no clips to edit.";
  if (!(e.grade in GRADES)) return "That colour grade does not exist.";
  if (!(e.width >= 320 && e.height >= 320 && e.width <= 3840 && e.height <= 3840)) return "The frame size is not valid.";
  if (!(e.fadeS >= 0 && e.fadeS <= 1)) return "The fade must be between 0 and 1 second.";
  if (!e.out || e.out.startsWith("-")) return "The output name is not valid.";
  for (const c of e.clips) {
    if (!FILE.test(c.file)) return "A clip has an unusable file name.";
    if (!(c.slotS > 0) || !(c.durationS >= c.slotS)) return "A clip is shorter than the time it must fill.";
  }
  return null;
}

/** The ffmpeg arguments; throws with the plain sentence from montageProblem. */
export function montageArgs(e: MontageEdit): string[] {
  const bad = montageProblem(e);
  if (bad) throw new Error(bad);
  const n = e.clips.length;
  const r3 = (x: number) => x.toFixed(3);
  const parts = e.clips.map((c, i) => {
    const start = (c.durationS - c.slotS) / 2;
    const d = Math.min(e.fadeS, c.slotS / 3);
    const fades = e.fadeS > 0 ? [`fade=t=in:st=0:d=${r3(d)}`, `fade=t=out:st=${r3(c.slotS - d)}:d=${r3(d)}`] : [];
    const chain = [
      `trim=start=${r3(start)}:duration=${r3(c.slotS)}`, "setpts=PTS-STARTPTS",
      `scale=${e.width}:${e.height}:force_original_aspect_ratio=increase`, `crop=${e.width}:${e.height}`, "setsar=1", `fps=${MONTAGE_FPS}`,
      GRADES[e.grade], ...fades,
    ];
    return `[${i}:v]${chain.join(",")}[v${i}]`;
  });
  const graph = `${parts.join(";")};${e.clips.map((_, i) => `[v${i}]`).join("")}concat=n=${n}:v=1:a=0[outv]`;
  return [
    "-nostdin", "-hide_banner", "-y",
    ...e.clips.flatMap((c) => ["-protocol_whitelist", "file", "-i", c.file]),
    "-filter_complex", graph, "-map", "[outv]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "17", "-pix_fmt", "yuv420p", "-r", String(MONTAGE_FPS), "-movflags", "+faststart", e.out,
  ];
}
