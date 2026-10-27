import { createHash } from "node:crypto";
import { redactSecretShapes } from "./log-redact";
import { LeaseLostError, runPaidCall, type ClaimLike, type PaidCallOutput, type PaidCallPorts } from "./paid-call";
import { worstCaseMicroUsd, type PriceCard } from "./spend";

// Our own agent loop (Doc 8 §2): identical safety rules for every provider. No IO here: the model step and the
// tools are injected. Every step reserves the worst case BEFORE the model is called; an unpriced model is refused
// before anything is reserved or sent.

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}
export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}
export interface StepResult {
  text: string;
  toolCalls: ToolCall[];
  usage: { inputTokens: number; outputTokens: number };
}
export interface AgentTool {
  name: string;
  run(args: unknown): Promise<string>;
  /** Called when a resumed run takes this tool's output from the checkpoint instead of running it, so the tool can rebuild any state its later calls rely on. */
  onReplay?(args: unknown, output: string): void;
}
export type ModelStep = (messages: Message[], idempotencyKey: string, signal?: AbortSignal) => Promise<StepResult>;

export class MaxStepsError extends Error {
  constructor(public readonly maxSteps: number) {
    super(`agent did not finish within ${maxSteps} steps`);
    this.name = "MaxStepsError";
  }
}

// How a stage pays for one step: the stage context's `paid` (it numbers the step and owns the call timeout). When given,
// `claim`/`ports` are not used; call keys then come from the stage's own step counter, so an agent run and other paid
// calls of the same stage can never share a call key.
export type PayStep = <T>(
  step: { reserveMicroUsd: number; budgetScopes: string[]; kind: "paid" | "cheap_text" },
  call: (key: string, signal: AbortSignal) => Promise<PaidCallOutput<T>>,
) => Promise<T>;

// Checkpoints (Doc 2 §4.2.3). A model step that settled is replayed by the paid-call layer without a provider call; this
// store does the same for the tools that step asked for, so a resumed run never repeats them. Tools are read-only: if
// the outputs of a settled step were never saved (crash between settle and save), only the unsaved tools run again.
// Rows are keyed by (step, position of the call in that step): provider-chosen ids are metadata only (they can repeat,
// be empty or be huge). A stored row is used only when tool name and argument hash match what is being asked now.
export interface StoredToolOutput {
  toolCallId: string;
  toolName: string;
  argsHash: string;
  output: string;
}
export interface AgentStepStore {
  loadOutputs(stepIndex: number): Promise<Map<number, StoredToolOutput> | null>;
  /**
   * Saves (first write wins) and returns what is now stored for those positions, so the caller can use the stored value.
   * null = the claim is stale (fence or owner changed): nothing was written.
   */
  saveOutputs(
    claim: ClaimLike,
    stepIndex: number,
    outputs: Array<StoredToolOutput & { index: number }>,
  ): Promise<Map<number, StoredToolOutput> | null>;
}

export const TOOL_OUTPUT_MAX_BYTES = 16 * 1024;
export const AGENT_STEPS_PER_RUN = 1000; // storage step = runOrdinal * this + loop step
const TRUNCATED = "\n[truncated]";

/**
 * What the model sees and what is stored (the same text in both, with or without a store): well-formed UTF-8, no NUL,
 * credential shapes redacted (not the generic long-run rule, which would break ordinary URLs), at most 16 KB. One pass,
 * idempotent.
 */
export function sanitizeToolOutput(raw: string): string {
  const clean = redactSecretShapes(raw.toWellFormed().replaceAll("\u0000", ""));
  const buf = Buffer.from(clean, "utf8");
  if (buf.length <= TOOL_OUTPUT_MAX_BYTES) return clean;
  let end = TOOL_OUTPUT_MAX_BYTES - Buffer.byteLength(TRUNCATED);
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--; // never cut inside a multi-byte character
  return buf.subarray(0, end).toString("utf8") + TRUNCATED;
}

/** Metadata-only id: well-formed, no NUL, at most 200 characters. Never throws. */
export function sanitizeToolCallId(id: unknown): string {
  return String(id ?? "").toWellFormed().replaceAll("\u0000", "").slice(0, 200);
}

export function hashToolArgs(args: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(args ?? null) ?? "null";
  } catch {
    json = "unserialisable";
  }
  return createHash("sha256").update(json).digest("hex");
}

export interface AgentOptions {
  /** With `store`, the claim that gates saves (required then). */
  claim?: ClaimLike;
  store?: AgentStepStore;
  /**
   * Which runAgent call of this stage run this is (0, 1, ...). Separates the checkpoints and the call-key step numbers of
   * repeated runs in one stage (Draft retries). Callers that run more than one agent per stage must pass a distinct value.
   */
  runOrdinal?: number;
  ports?: PaidCallPorts;
  paid?: PayStep;
  price: PriceCard | undefined;
  budgetScopes: string[];
  maxOutputTokens: number;
  maxSteps: number;
  step: ModelStep;
  tools: AgentTool[];
  messages: Message[];
  signal?: AbortSignal;
}
export interface AgentResult {
  text: string;
  steps: number;
  messages: Message[];
  spentMicroUsd: number;
}

// Upper bound on input tokens: a token is never shorter than one byte, plus fixed per-message framing.
export function estimateInputTokens(messages: Message[]): number {
  let n = 0;
  for (const m of messages) {
    n += Buffer.byteLength(m.content, "utf8") + 16;
    for (const c of m.toolCalls ?? []) n += Buffer.byteLength(JSON.stringify(c.args ?? null), "utf8") + c.name.length + 16;
  }
  return n;
}

export async function runAgent(o: AgentOptions): Promise<AgentResult> {
  if (!Number.isSafeInteger(o.maxSteps) || o.maxSteps < 1) throw new RangeError("maxSteps must be >= 1");
  if (o.store && !o.claim) throw new TypeError("runAgent needs `claim` to save checkpoints with a `store`");
  const ordinal = o.runOrdinal ?? 0;
  if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal > 1_000_000) throw new RangeError("runOrdinal out of range");
  if (ordinal > 0 && o.maxSteps > AGENT_STEPS_PER_RUN) throw new RangeError(`maxSteps must be <= ${AGENT_STEPS_PER_RUN}`);
  const byName = new Map(o.tools.map((t) => [t.name, t]));
  const messages = [...o.messages];
  let spent = 0;

  for (let stepIndex = 0; stepIndex < o.maxSteps; stepIndex++) {
    o.signal?.throwIfAborted();
    // Throws UnpricedCallError for a model without a price: nothing reserved, nothing sent.
    const reserveMicroUsd = worstCaseMicroUsd(o.price, {
      inputTokens: estimateInputTokens(messages),
      maxOutputTokens: o.maxOutputTokens,
    });
    const globalStep = ordinal * AGENT_STEPS_PER_RUN + stepIndex;
    const snapshot = [...messages];
    const call = async (key: string, signal?: AbortSignal): Promise<PaidCallOutput<StepResult>> => {
      const result = await o.step(snapshot, key, signal ?? o.signal);
      const actualMicroUsd = worstCaseMicroUsd(o.price, {
        inputTokens: result.usage.inputTokens,
        maxOutputTokens: result.usage.outputTokens,
      });
      return { result, actualMicroUsd };
    };
    let res: StepResult;
    if (o.paid) res = await o.paid({ reserveMicroUsd, budgetScopes: o.budgetScopes, kind: "paid" }, call);
    else {
      if (!o.claim || !o.ports) throw new TypeError("runAgent needs either `paid` or `claim` and `ports`");
      res = await runPaidCall(
        o.ports,
        { claim: o.claim, stepIndex: globalStep, toolCallIndex: 0, reserveMicroUsd, budgetScopes: o.budgetScopes, kind: "paid" },
        call,
      );
    }
    spent += worstCaseMicroUsd(o.price, { inputTokens: res.usage.inputTokens, maxOutputTokens: res.usage.outputTokens });
    messages.push({ role: "assistant", content: res.text, toolCalls: res.toolCalls });
    if (res.toolCalls.length === 0) return { text: res.text, steps: stepIndex + 1, messages, spentMicroUsd: spent };

    const stored = o.store ? await o.store.loadOutputs(globalStep) : null;
    for (const [index, call] of res.toolCalls.entries()) {
      o.signal?.throwIfAborted();
      const argsHash = hashToolArgs(call.args);
      const hit = stored?.get(index);
      if (hit && hit.toolName === call.name && hit.argsHash === argsHash) {
        try { byName.get(call.name)?.onReplay?.(call.args, hit.output); } catch { /* rebuilding tool state must never fail a replay */ }
        messages.push({ role: "tool", content: hit.output, toolCallId: call.id });
        continue;
      }
      const tool = byName.get(call.name);
      let out: string;
      let failed = false;
      if (!tool) {
        out = `error: unknown tool "${call.name}"`;
        failed = true;
      } else {
        try {
          out = await tool.run(call.args);
        } catch (err) {
          o.signal?.throwIfAborted(); // an abort is not a tool result
          out = `error: ${err instanceof Error ? err.message : "tool failed"}`;
          failed = true;
        }
      }
      out = sanitizeToolOutput(out);
      // A failed tool is not checkpointed: it is read-only, so a resume simply tries it again.
      if (o.store && !failed) {
        const mine = { index, toolCallId: sanitizeToolCallId(call.id), toolName: call.name, argsHash, output: out };
        const saved = await o.store.saveOutputs(o.claim!, globalStep, [mine]);
        if (!saved) throw new LeaseLostError(`agent_steps:${o.claim!.stageRunId}:${globalStep}:${index}`);
        // Use what is stored (first write wins) so this run and every replay show the model the same text.
        const row = saved.get(index);
        if (row && row.toolName === call.name && row.argsHash === argsHash) out = row.output;
      }
      messages.push({ role: "tool", content: out, toolCallId: call.id });
    }
  }
  throw new MaxStepsError(o.maxSteps);
}
