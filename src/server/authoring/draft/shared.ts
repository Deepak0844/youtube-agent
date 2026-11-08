import type pg from "pg";
import { z } from "zod";
import type { AgentStepStore } from "@/server/core/agent-loop";
import { KnownFailure } from "@/server/core/paid-call";
import type { Lang } from "@/server/core/lang";
import type { LengthRange, Outline } from "@/server/core/long-form";
import type { Script } from "@/server/core/script-contract";
import type { LlmClient } from "@/server/llm/client";
import type { createWebTools } from "@/server/llm/web-tools";

export type WebTools = ReturnType<typeof createWebTools>;

export interface DraftDeps {
  llm: LlmClient;
  web: WebTools;
  db: pg.Pool;
  /** Manual spike only: skips the database lookup of the routed model's draft_mode. */
  mode?: "agent" | "search_then_write";
  /** Agent checkpoints. Default: the stage's Postgres store. `null` = none (manual spike only; a resumed run would repeat tools). */
  store?: AgentStepStore | null;
}

export interface DraftInput {
  topic: string;
  lang: Lang;
  kind: "scene_kit" | "tsx" | "collage" | "ai" | "scale3d" | "scene3d" | "scene3d_code";
  /** Defaults to "short". */
  format?: "short" | "long";
  notes?: string;
  feedback?: string;
  /** Long videos: the approved outline and the chosen minutes range. The script is written against these chapters. */
  long?: { outline: Outline; range: LengthRange };
}

export interface DraftResult {
  script: Script;
  spentMicroUsd: number;
}

/** Draft retries after a rejected draft (each is a real counted, reserved call). */
export const MAX_DRAFT_RETRIES = 2;
export const DRAFT_MAX_OUTPUT_TOKENS = 4000;
/** A long script is many times longer than a short one (narration plus one beat line per few sentences, in any language). */
export const LONG_DRAFT_MAX_OUTPUT_TOKENS = 24_000;
export const draftMaxOutputTokens = (format: "short" | "long"): number => (format === "long" ? LONG_DRAFT_MAX_OUTPUT_TOKENS : DRAFT_MAX_OUTPUT_TOKENS);

/** Any JSON object; the script contract (validateScript) does the real checking. */
export const rawDraftSchema = z.looseObject({});

/** The stage fails as a known failure `draft_invalid`; money already spent stays counted in the ledger. */
export class DraftInvalidError extends KnownFailure {
  constructor(
    public readonly problems: string[],
    public readonly spentMicroUsd: number,
  ) {
    super(`draft_invalid: ${problems.join("; ")}`.slice(0, 600));
    this.name = "DraftInvalidError";
  }
}
