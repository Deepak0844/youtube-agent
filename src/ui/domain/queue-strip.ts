import { stagesFor, type CutStage, type StageStatus } from "./stages";

// Plain string unions on purpose: the UI layer does not import from the server layers (eslint import boundaries).
export type EngineStage = "outline" | "draft" | "pictures" | "build" | "generate" | "tts" | "render" | "voice" | "sfx" | "qa";
export type RunState = "queued" | "running" | "succeeded" | "failed" | "needs_decision" | "cancelled";
export type OpenGate = "outline" | "script" | "cost" | "look" | "video" | "evidence" | "publish";

// Turns what the engine knows about one short video (newest run per stage, the open gate, the upload row) into the
// eight segments of the Cut strip. Pure: no IO. The engine has more stages than the strip has segments, so some
// segments cover two (build+generate, tts+voice). Doc 3 names the segments, Doc 2 the stages.

const GROUPS: ReadonlyArray<{ key: string; stages: readonly EngineStage[] }> = [
  { key: "draft", stages: ["draft"] },
  { key: "build", stages: ["pictures", "build", "generate"] },
  { key: "voice", stages: ["tts", "voice"] },
  { key: "render", stages: ["render"] },
  { key: "sound", stages: ["sfx"] },
  { key: "check", stages: ["qa"] },
  { key: "review", stages: [] },
  { key: "publish", stages: [] },
];
const GATE_SEGMENT: Partial<Record<OpenGate, number>> = { script: 0, cost: 1, look: 3, video: 6, evidence: 6, publish: 7 };
// A long video has one more segment in front (Outline), so every index shifts by one and its own gate is segment 0.
const OUTLINE_GROUP: { key: string; stages: readonly EngineStage[] } = { key: "outline", stages: ["outline"] };

export interface StripInput {
  runs: Partial<Record<EngineStage, RunState>>;
  /** The owner gate the video is waiting at, or null. */
  openGate: OpenGate | null;
  /** Newest upload row status for the video, or null. */
  upload: "publish_approved" | "uploading" | "uploaded" | "upload_failed" | null;
}

function fromRuns(stages: readonly EngineStage[], runs: StripInput["runs"]): StageStatus {
  const s = stages.map((n) => runs[n]).filter((x): x is RunState => x !== undefined);
  if (s.some((x) => x === "failed")) return "failed";
  if (s.some((x) => x === "needs_decision")) return "held";
  if (s.some((x) => x === "running" || x === "queued")) return "running";
  if (s.length > 0 && s.every((x) => x === "succeeded")) return "done";
  if (s.some((x) => x === "cancelled")) return "failed";
  return "todo";
}

export function cutStages(i: StripInput, format: "short" | "long" = "short"): CutStage[] {
  const long = format === "long";
  const defs = stagesFor(format);
  const groups = long ? [OUTLINE_GROUP, ...GROUPS] : GROUPS;
  const o = long ? 1 : 0; // segment offset
  const reached = groups.reduce((hi, g, idx) => (g.stages.some((n) => i.runs[n] !== undefined) ? idx : hi), -1);
  const seg = i.openGate === null ? undefined : i.openGate === "outline" ? 0 : GATE_SEGMENT[i.openGate] === undefined ? undefined : GATE_SEGMENT[i.openGate]! + o;
  const gateAt = seg ?? -1;
  return defs.map((d, idx): CutStage => {
    const g = groups[idx]!;
    if (idx === gateAt) return { ...d, state: "held", gate: i.openGate! };
    if (gateAt >= 0) return { ...d, state: idx < gateAt ? "done" : "todo" };
    if (idx === 7 + o) {
      if (i.upload === "uploaded") return { ...d, state: "done" };
      if (i.upload === "upload_failed") return { ...d, state: "failed" };
      if (i.upload === "uploading" || i.upload === "publish_approved") return { ...d, state: "running" };
      return { ...d, state: "todo" };
    }
    if (idx === 6 + o) return { ...d, state: i.upload ? "done" : "todo" };
    const own = fromRuns(g.stages, i.runs);
    if (idx < reached && own === "todo") return { ...d, state: "done" };
    if (idx < reached && own === "running") return { ...d, state: "done" };
    return { ...d, state: own };
  });
}
