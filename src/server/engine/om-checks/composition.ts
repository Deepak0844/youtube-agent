// Port of OpenMontage tools/analysis/composition_validator.py (AGPL-3.0, https://github.com/calesthio/OpenMontage) at the
// commit in engine-kit/openmontage/UPSTREAM.json. Same checks, same order, same messages; the Remotion assets root is the
// run's assets/ folder (the caller resolves names). Proven equal on tests/fixtures/openmontage/goldens/composition-*.json.

export interface CompositionFiles {
  /** True when the named file exists in the assets folder. */
  exists(name: string): boolean;
  /** Audio length in seconds, or null when it cannot be read. */
  durationS(name: string): number | null;
}
export interface CompositionResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  info: string[];
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {});
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
/** Python's str() of a JSON number (an integer prints without ".0"). */
const py = (n: number): string => String(n);
const f1 = (n: number): string => n.toFixed(1);

export function validateComposition(comp: Obj, files: CompositionFiles): CompositionResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const info: string[] = [];
  const cuts = Array.isArray(comp.cuts) ? comp.cuts.map(obj) : [];
  const audio = obj(comp.audio);
  const done = (): CompositionResult => ({ ok: errors.length === 0, errors, warnings, info });

  // Check 1: cuts exist
  if (cuts.length === 0) {
    errors.push("No cuts defined in composition");
    return done();
  }

  // Check 2: video duration (Python starts from 0.0, so a list with no positive end prints "0.0")
  let video = 0;
  for (const c of cuts) video = Math.max(video, num(c.out_seconds));
  const videoText = video > 0 ? py(video) : "0.0";
  info.push(`Video duration: ${videoText}s (${cuts.length} cuts)`);
  info.push("Render runtime: default (remotion); assets root: assets");

  // Check 3: cut ordering (sorted by start, stable; the id falls back to the position in that order)
  const sorted = cuts.map((c, i) => ({ c, i })).sort((a, b) => num(a.c.in_seconds) - num(b.c.in_seconds) || a.i - b.i);
  sorted.forEach(({ c }, i) => {
    const a = num(c.in_seconds);
    const b = num(c.out_seconds);
    if (b <= a) errors.push(`Cut '${c.id === undefined ? i : String(c.id)}': out_seconds (${py(b)}) <= in_seconds (${py(a)})`);
  });

  // Check 4: asset files exist
  for (const c of cuts) {
    const source = str(c.source);
    if (source && !files.exists(source)) errors.push(`Missing asset: ${source} (looked in assets)`);
    const bg = str(c.backgroundImage);
    if (bg && !files.exists(bg)) errors.push(`Missing background image: ${bg}`);
  }

  // Check 5: narration duration vs video duration
  const narration = str(obj(audio.narration).src);
  if (narration) {
    if (!files.exists(narration)) errors.push(`Missing narration audio: ${narration}`);
    else {
      const d = files.durationS(narration);
      if (d !== null) {
        info.push(`Narration duration: ${f1(d)}s`);
        const over = d - video;
        if (over > 1.0) errors.push(`Narration (${f1(d)}s) exceeds video (${videoText}s) by ${f1(over)}s — audio will be cut off`);
        else if (over > 0) warnings.push(`Narration (${f1(d)}s) slightly exceeds video (${videoText}s) by ${f1(over)}s`);
      } else warnings.push(`Could not probe narration duration: ${narration}`);
    }
  }

  // Check 6: music duration
  const music = str(obj(audio.music).src);
  if (music) {
    if (!files.exists(music)) errors.push(`Missing music audio: ${music}`);
    else {
      const d = files.durationS(music);
      if (d !== null) {
        info.push(`Music duration: ${f1(d)}s`);
        if (d < video) warnings.push(`Music (${f1(d)}s) is shorter than video (${videoText}s) — will end early`);
      }
    }
  }

  // Check 7: no audio at all
  if (!narration && !music) warnings.push("No audio configured (no narration or music)");
  return done();
}
