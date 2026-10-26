import { runPaidCall, type ClaimLike, type PaidCallPorts } from "./paid-call";
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

export interface AgentOptions {
  claim: ClaimLike;
  ports: PaidCallPorts;
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
    const res = await runPaidCall(
      o.ports,
      { claim: o.claim, stepIndex, toolCallIndex: 0, reserveMicroUsd, budgetScopes: o.budgetScopes, kind: "paid" },
      async (key) => {
        const result = await o.step(snapshot, key, o.signal);
        const actualMicroUsd = worstCaseMicroUsd(o.price, {
          inputTokens: result.usage.inputTokens,
          maxOutputTokens: result.usage.outputTokens,
        });
        return { result, actualMicroUsd };
      },
    );
    spent += worstCaseMicroUsd(o.price, { inputTokens: res.usage.inputTokens, maxOutputTokens: res.usage.outputTokens });
    messages.push({ role: "assistant", content: res.text, toolCalls: res.toolCalls });
    if (res.toolCalls.length === 0) return { text: res.text, steps: stepIndex + 1, messages, spentMicroUsd: spent };

    for (const call of res.toolCalls) {
      o.signal?.throwIfAborted();
      const tool = byName.get(call.name);
      let out: string;
      if (!tool) out = `error: unknown tool "${call.name}"`;
      else {
        try {
          out = await tool.run(call.args);
        } catch (err) {
          out = `error: ${err instanceof Error ? err.message : "tool failed"}`;
        }
      }
      messages.push({ role: "tool", content: out, toolCallId: call.id });
    }
  }
  throw new MaxStepsError(o.maxSteps);
}
