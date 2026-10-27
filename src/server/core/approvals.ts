import { canonicalJson, gateHash, sha256Hex } from "@/server/core/content-hash";
import type { GateId } from "@/server/core/gates";

// Hash-bound gate rules (Doc 02 4.4). Pure: no IO. The live hash of a gate is computed from the latest stored content;
// db/approvals.ts reads the rows and calls this. An approval counts only while its stored hash equals the live hash.

/** The only actor a gate accepts. The type allows nothing else; actorProblem enforces it at runtime for untyped callers. */
export type GateActor = { kind: "session"; sessionId: string };
export const ACTOR_REASON = "only the signed-in owner can do this";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The actor must be exactly { kind: "session", sessionId: <uuid from requireOwner> }. */
export function actorProblem(actor: unknown): string | null {
  if (typeof actor !== "object" || actor === null) return ACTOR_REASON;
  const a = actor as { kind?: unknown; sessionId?: unknown };
  const keys = Object.keys(actor);
  if (a.kind === "session" && typeof a.sessionId === "string" && UUID_RE.test(a.sessionId) && keys.length === 2) return null;
  return ACTOR_REASON;
}

const NOTE_REASON = "write a short note (3 to 1000 characters) for the rewrite";
// Control characters (NUL included) except tab, line feed and carriage return.
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** Counts characters (code points), as Postgres does. NUL, other control characters and lone surrogates are refused, never thrown on. */
export function noteProblem(note: unknown): string | null {
  if (typeof note !== "string" || !note.isWellFormed() || CONTROL_RE.test(note)) return NOTE_REASON;
  const n = [...note.trim()].length;
  return n < 3 || [...note].length > 1000 ? NOTE_REASON : null;
}

/** Gates whose action exists in Phase 2. The others are refused until their phase ships. */
export const IMPLEMENTED_GATES = ["script", "cost", "video", "evidence", "publish"] as const;
export type ImplementedGate = (typeof IMPLEMENTED_GATES)[number];
export const isImplementedGate = (g: unknown): g is ImplementedGate => typeof g === "string" && (IMPLEMENTED_GATES as readonly string[]).includes(g);

export interface StoredContent {
  sha256: string;
  body: unknown;
  filePath?: string | null;
}
export interface LiveInputs {
  /** Newest version of each content kind, absent when none exists. */
  content: Partial<Record<"script" | "cost_plan" | "video" | "evidence" | "metadata", StoredContent>>;
  channelId: string | null;
}
export type LiveHash = { ok: true; hash: string } | { ok: false; reason: string };

const NOTHING = (what: string): LiveHash => ({ ok: false, reason: `nothing to approve yet: no ${what}` });
const field = (body: unknown, key: string): unknown => (typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>)[key] : undefined);
const partHash = (v: unknown): string => sha256Hex(canonicalJson(v));
/** The producer-supplied sha256 is not trusted alone: the stored body and file path are part of what is approved. */
const contentDigest = (c: StoredContent): string => partHash({ sha256: c.sha256, body: c.body ?? null, file_path: c.filePath ?? null });
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const COST_PATHS = ["scene_kit", "tsx", "collage", "ai"];
const costPlanProblem = (b: unknown): string | null => {
  const ok =
    isObj(field(b, "providers_models")) && Object.keys(field(b, "providers_models") as object).length > 0 &&
    typeof field(b, "path") === "string" && COST_PATHS.includes(field(b, "path") as string) &&
    isObj(field(b, "library_scene_versions")) &&
    isObj(field(b, "quote")) && typeof (field(b, "quote") as Record<string, unknown>).micro_usd === "string" && /^[0-9]+$/.test((field(b, "quote") as Record<string, unknown>).micro_usd as string);
  return ok ? null : "the cost plan is incomplete: it needs models, a path, library scene versions and a quote in micro-USD";
};

/**
 * The hash of exactly what the owner approves. `cost` and `publish` also bind fields of the stored body, so a field edited
 * without a new sha (or a new version) still changes the hash. Missing pieces refuse (fail closed), never hash as empty.
 */
export function liveHash(gate: GateId, i: LiveInputs): LiveHash {
  try {
    return liveHashUnsafe(gate, i);
  } catch {
    return { ok: false, reason: "the stored content cannot be read; ask for it to be rebuilt" };
  }
}

function liveHashUnsafe(gate: GateId, i: LiveInputs): LiveHash {
  const c = i.content;
  switch (gate) {
    case "script":
      return c.script ? { ok: true, hash: gateHash("script", { script: contentDigest(c.script) }) } : NOTHING("script");
    case "video":
      return c.video ? { ok: true, hash: gateHash("video", { video_file: contentDigest(c.video) }) } : NOTHING("video");
    case "evidence":
      return c.evidence ? { ok: true, hash: gateHash("evidence", { evidence_file: contentDigest(c.evidence) }) } : NOTHING("evidence file");
    case "cost": {
      if (!c.cost_plan) return NOTHING("cost plan");
      const b = c.cost_plan.body;
      // The plan itself records the models, path, scene versions and quote the owner approves; routing settings are NOT re-read
      // here on purpose: a later settings change must not silently re-price an approved plan, and the stages must run the plan's models.
      const problem = costPlanProblem(b);
      if (problem) return { ok: false, reason: problem };
      return {
        ok: true,
        hash: gateHash("cost", {
          cost_plan: contentDigest(c.cost_plan),
          providers_models: partHash(field(b, "providers_models")),
          path: partHash(field(b, "path")),
          library_scene_versions: partHash(field(b, "library_scene_versions")),
          quote: partHash(field(b, "quote")),
        }),
      };
    }
    case "publish": {
      if (!c.video) return NOTHING("video");
      if (!c.metadata) return NOTHING("title and description");
      if (!c.evidence) return NOTHING("evidence file");
      if (!i.channelId) return { ok: false, reason: "choose a channel before publishing" };
      const visibility = field(c.metadata.body, "visibility");
      if (typeof visibility !== "string" || visibility === "") return { ok: false, reason: "the metadata needs a visibility before publishing" };
      return {
        ok: true,
        hash: gateHash("publish", {
          video: contentDigest(c.video),
          metadata: contentDigest(c.metadata),
          evidence: contentDigest(c.evidence),
          channel: partHash(i.channelId),
          visibility: partHash(visibility),
          publish_at: partHash(field(c.metadata.body, "publish_at") ?? null),
        }),
      };
    }
    default:
      return { ok: false, reason: "this approval is not available yet" };
  }
}

export type GateContentKind = "script" | "cost_plan" | "video" | "evidence" | "metadata";
/** The content kinds each implemented gate's hash is computed from (and records in the approval row). */
export const GATE_KINDS: Readonly<Record<ImplementedGate, readonly GateContentKind[]>> = Object.freeze({
  script: ["script"],
  cost: ["cost_plan"],
  video: ["video"],
  evidence: ["evidence"],
  publish: ["video", "metadata", "evidence"],
});
