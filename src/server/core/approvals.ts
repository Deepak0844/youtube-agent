import { canonicalJson, gateHash, sha256Hex } from "@/server/core/content-hash";
import type { GateId } from "@/server/core/gates";

// Hash-bound gate rules (Doc 02 4.4). Pure: no IO. The live hash of a gate is computed from the latest stored content;
// db/approvals.ts reads the rows and calls this. An approval counts only while its stored hash equals the live hash.

/** The only actor a gate accepts. The type allows nothing else; actorProblem enforces it at runtime for untyped callers. */
export type GateActor = { kind: "session" };
export const ACTOR_REASON = "only the signed-in owner can do this";

export function actorProblem(actor: unknown): string | null {
  if (typeof actor === "object" && actor !== null && (actor as { kind?: unknown }).kind === "session" && Object.keys(actor).length === 1) return null;
  return ACTOR_REASON;
}

export function noteProblem(note: unknown): string | null {
  if (typeof note !== "string") return "write a short note (3 to 1000 characters) for the rewrite";
  const n = note.trim().length;
  return n < 3 || note.length > 1000 ? "write a short note (3 to 1000 characters) for the rewrite" : null;
}

/** Gates whose action exists in Phase 2. The others are refused until their phase ships. */
export const IMPLEMENTED_GATES = ["script", "cost", "video", "evidence", "publish"] as const;
export type ImplementedGate = (typeof IMPLEMENTED_GATES)[number];
export const isImplementedGate = (g: unknown): g is ImplementedGate => typeof g === "string" && (IMPLEMENTED_GATES as readonly string[]).includes(g);

export interface StoredContent {
  sha256: string;
  body: unknown;
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

/**
 * The hash of exactly what the owner approves. `cost` and `publish` also bind fields of the stored body, so a field edited
 * without a new sha (or a new version) still changes the hash. Missing pieces refuse (fail closed), never hash as empty.
 */
export function liveHash(gate: GateId, i: LiveInputs): LiveHash {
  const c = i.content;
  switch (gate) {
    case "script":
      return c.script ? { ok: true, hash: gateHash("script", { script: c.script.sha256 }) } : NOTHING("script");
    case "video":
      return c.video ? { ok: true, hash: gateHash("video", { video_file: c.video.sha256 }) } : NOTHING("video");
    case "evidence":
      return c.evidence ? { ok: true, hash: gateHash("evidence", { evidence_file: c.evidence.sha256 }) } : NOTHING("evidence file");
    case "cost": {
      if (!c.cost_plan) return NOTHING("cost plan");
      const b = c.cost_plan.body;
      const keys = ["providers_models", "path", "library_scene_versions", "quote"] as const;
      if (keys.some((k) => field(b, k) === undefined)) return { ok: false, reason: "the cost plan is incomplete: it needs models, path, library scene versions and a quote" };
      return {
        ok: true,
        hash: gateHash("cost", {
          cost_plan: c.cost_plan.sha256,
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
          video: c.video.sha256,
          metadata: c.metadata.sha256,
          evidence: c.evidence.sha256,
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
