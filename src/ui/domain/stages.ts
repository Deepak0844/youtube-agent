// Stage lists per format (Doc 2 §4.1). Segments that do not apply are not drawn.
export type Format = "short" | "long";
export type Aspect = "9:16" | "16:9";
export type StageStatus = "todo" | "running" | "done" | "held" | "failed";

export interface StageDef {
  key: string;
  label: string;
}

/** What a stage looks like right now. `gate` is set when held, `chapters` only for long videos. */
export interface StageState {
  state: StageStatus;
  /** 0-100, for a running stage. */
  progress?: number;
  /** Name of the gate a held stage waits at, e.g. "script". */
  gate?: string;
  /** One status per chapter (long videos only). */
  chapters?: StageStatus[];
}

export type CutStage = StageDef & StageState;

const COMMON: StageDef[] = [
  { key: "draft", label: "Draft" },
  { key: "build", label: "Build" },
  { key: "voice", label: "Voice" },
  { key: "render", label: "Render" },
  { key: "sound", label: "Sound" },
  { key: "check", label: "Check" },
  { key: "review", label: "Review" },
  { key: "publish", label: "Publish" },
];

export function stagesFor(format: Format): StageDef[] {
  return format === "long" ? [{ key: "outline", label: "Outline" }, ...COMMON] : COMMON;
}

export const aspectFor = (format: Format): Aspect => (format === "long" ? "16:9" : "9:16");
