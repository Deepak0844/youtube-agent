import { stagesFor, type CutStage, type StageStatus } from "./stages";

// Plain string unions on purpose: the UI layer does not import from the server layers (eslint import boundaries).
export type EngineStage = "draft" | "build" | "generate" | "tts" | "render" | "voice" | "sfx" | "qa";
export type RunState = "queued" | "running" | "succeeded" | "failed" | "needs_decision" | "cancelled";
export type OpenGate = "script" | "cost" | "video" | "evidence" | "publish";

// Turns what the engine knows about one short video (newest run per stage, the open gate, the upload row) into the
// eight segments of the Cut strip. Pure: no IO. The engine has more stages than the strip has segments, so some
// segments cover two (build+generate, tts+voice). Doc 3 names the segments, Doc 2 the stages.

const GROUPS: ReadonlyArray<{ key: string; stages: readonly EngineStage[] }> = [
  { key: "draft", stages: ["draft"] },
  { key: "build", stages: ["build", "generate"] },
  { key: "voice", stages: ["tts", "voice"] },
  { key: "render", stages: ["render"] },
  { key: "sound", stages: ["sfx"] },
  { key: "check", stages: ["qa"] },
  { key: "review", stages: [] },
  { key: "publish", stages: [] },
];
const GATE_SEGMENT: Partial<Record<OpenGate, number>> = { script: 0, cost: 1, video: 6, evidence: 6, publish: 7 };

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

export function cutStages(i: StripInput): CutStage[] {
  const defs = stagesFor("short");
  const reached = GROUPS.reduce((hi, g, idx) => (g.stages.some((n) => i.runs[n] !== undefined) ? idx : hi), -1);
  const gateAt = i.openGate ? (GATE_SEGMENT[i.openGate] ?? -1) : -1;
  return defs.map((d, idx): CutStage => {
    const g = GROUPS[idx]!;
    if (idx === gateAt) return { ...d, state: "held", gate: i.openGate! };
    if (gateAt >= 0) return { ...d, state: idx < gateAt ? "done" : "todo" };
    if (idx === 7) {
      if (i.upload === "uploaded") return { ...d, state: "done" };
      if (i.upload === "upload_failed") return { ...d, state: "failed" };
      if (i.upload === "uploading" || i.upload === "publish_approved") return { ...d, state: "running" };
      return { ...d, state: "todo" };
    }
    if (idx === 6) return { ...d, state: i.upload ? "done" : "todo" };
    const own = fromRuns(g.stages, i.runs);
    if (idx < reached && own === "todo") return { ...d, state: "done" };
    if (idx < reached && own === "running") return { ...d, state: "done" };
    return { ...d, state: own };
  });
}
