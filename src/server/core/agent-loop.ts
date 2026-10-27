import { redactLine } from "./log-redact";
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
export interface AgentStepStore {
  loadOutputs(stepIndex: number): Promise<Map<string, string> | null>;
  /** false = the claim is stale (fence or owner changed): nothing was written. */
  saveOutputs(claim: ClaimLike, stepIndex: number, outputs: Array<{ toolCallId: string; output: string }>): Promise<boolean>;
}

export const TOOL_OUTPUT_MAX_BYTES = 16 * 1024;
const TRUNCATED = "\n[truncated]";

/** What the model sees and what is stored: well-formed UTF-8, no NUL, credential shapes redacted, at most 16 KB. Idempotent. */
export function sanitizeToolOutput(raw: string): string {
  const clean = redactLine(raw.toWellFormed().replaceAll("\u0000", ""));
  const buf = Buffer.from(clean, "utf8");
  if (buf.length <= TOOL_OUTPUT_MAX_BYTES) return clean;
  let end = TOOL_OUTPUT_MAX_BYTES - Buffer.byteLength(TRUNCATED);
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--; // never cut inside a multi-byte character
  return buf.subarray(0, end).toString("utf8") + TRUNCATED;
}

export interface AgentOptions {
  /** With `store`, the claim that gates saves (required then). */
  claim?: ClaimLike;
  store?: AgentStepStore;
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
        { claim: o.claim, stepIndex, toolCallIndex: 0, reserveMicroUsd, budgetScopes: o.budgetScopes, kind: "paid" },
        call,
      );
    }
    spent += worstCaseMicroUsd(o.price, { inputTokens: res.usage.inputTokens, maxOutputTokens: res.usage.outputTokens });
    messages.push({ role: "assistant", content: res.text, toolCalls: res.toolCalls });
    if (res.toolCalls.length === 0) return { text: res.text, steps: stepIndex + 1, messages, spentMicroUsd: spent };

    const stored = o.store ? await o.store.loadOutputs(stepIndex) : null;
    for (const call of res.toolCalls) {
      o.signal?.throwIfAborted();
      let out = stored?.get(call.id);
      if (out === undefined) {
        const tool = byName.get(call.name);
        if (!tool) out = `error: unknown tool "${call.name}"`;
        else {
          try {
            out = await tool.run(call.args);
          } catch (err) {
            out = `error: ${err instanceof Error ? err.message : "tool failed"}`;
          }
        }
        if (o.store) {
          // The same cleaned text goes to the model now and to every replay, so resumed messages are identical.
          out = sanitizeToolOutput(out);
          const ok = await o.store.saveOutputs(o.claim!, stepIndex, [{ toolCallId: call.id, output: out }]);
          if (!ok) throw new LeaseLostError(`agent_steps:${o.claim!.stageRunId}:${stepIndex}:${call.id}`);
        }
      }
      messages.push({ role: "tool", content: out, toolCallId: call.id });
    }
  }
  throw new MaxStepsError(o.maxSteps);
}
