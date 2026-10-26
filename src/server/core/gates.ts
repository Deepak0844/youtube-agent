// Doc 02 4.4 "Approvals are bound to exactly what you saw", as data. Pure: no IO. Every human gate is approved by a
// logged-in SESSION only (never an API token, the system or a job) and carries the hash of the content the owner saw;
// any change to that content voids the approval. Later phases implement the actions; tests/support/gate-invariants.ts
// holds the shared checks every implementation must pass, and tests/unit/gates.test.ts fails the build when a row here
// has no suite registered.

export const GATE_IDS = ["outline", "script", "cost", "chapter", "video", "thumbnail", "evidence", "publish", "comment_reply", "allow_public", "live_title"] as const;
export type GateId = (typeof GATE_IDS)[number];

export interface Gate {
  readonly id: GateId;
  readonly label: string;
  /** What the approval hash must cover (Doc 02 4.4 "Hash covers" column). Changing any of these voids the approval. */
  readonly hashCovers: readonly string[];
  /** Who may approve. The only legal value is "session": the type forbids anything weaker. */
  readonly approvedBy: "session";
  /** The approval carries the hash of what the owner saw and is rejected when the current content differs. */
  readonly hashBound: true;
}

const row = (id: GateId, label: string, hashCovers: string[]): Gate => Object.freeze({ id, label, hashCovers: Object.freeze([...hashCovers]), approvedBy: "session", hashBound: true });

export const GATES: readonly Gate[] = Object.freeze([
  row("outline", "Outline", ["outline"]),
  row("script", "Script", ["script"]),
  row("cost", "Cost", ["cost_plan", "providers_models", "path", "library_scene_versions", "quote"]),
  row("chapter", "Chapter review (long, optional)", ["chapter_render"]),
  row("video", "Video", ["video_file"]),
  row("thumbnail", "Thumbnail (long)", ["thumbnail_image"]),
  row("evidence", "Evidence sign-off", ["evidence_file"]),
  row("publish", "Publish", ["video", "metadata", "evidence", "channel", "visibility", "publish_at"]),
  row("comment_reply", "Comment reply", ["reply_text", "target_comment"]),
  row("allow_public", "Channel allow_public", ["channel", "flag_value"]),
  row("live_title", "Live title switch (title experiments)", ["video", "new_title"]),
]);

/** Roadmap phase (Doc 05) in which each gate's action ships and its real test suite must replace the registry todo. */
export const GATE_ROADMAP_PHASE: Readonly<Record<GateId, number>> = Object.freeze({
  outline: 6,
  script: 4,
  cost: 4,
  chapter: 6,
  video: 4,
  thumbnail: 6,
  evidence: 5,
  publish: 5,
  comment_reply: 8,
  allow_public: 5,
  live_title: 8,
});

export function gateById(id: GateId): Gate {
  const g = GATES.find((x) => x.id === id);
  if (!g) throw new Error(`unknown gate: ${String(id)}`);
  return g;
}
