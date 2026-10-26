import { generateText, jsonSchema, tool, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import type { Message, ModelStep, StepResult } from "@/server/core/agent-loop";

// Adapter: one model call = one agent-loop step, on the Vercel AI SDK. Tools are declared WITHOUT `execute`, so the
// SDK never runs them: our loop does, jailed. The rest of the code never imports a provider package.

export interface ToolDecl {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function toModelMessages(messages: Message[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  const names = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "system") continue; // passed as `instructions`, the SDK rejects system messages in `messages`
    if (m.role === "user") out.push({ role: m.role, content: m.content });
    else if (m.role === "assistant") {
      for (const c of m.toolCalls ?? []) names.set(c.id, c.name);
      out.push({
        role: "assistant",
        content: [
          ...(m.content ? [{ type: "text" as const, text: m.content }] : []),
          ...(m.toolCalls ?? []).map((c) => ({ type: "tool-call" as const, toolCallId: c.id, toolName: c.name, input: c.args })),
        ],
      });
    } else {
      out.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: m.toolCallId ?? "",
            toolName: names.get(m.toolCallId ?? "") ?? "unknown",
            output: { type: "text", value: m.content },
          },
        ],
      });
    }
  }
  return out;
}

export function createAiSdkStep(model: LanguageModel, decls: ToolDecl[], maxOutputTokens: number): ModelStep {
  const tools: ToolSet = Object.fromEntries(
    decls.map((d) => [d.name, tool({ description: d.description, inputSchema: jsonSchema(d.inputSchema) })]),
  );
  return async (messages, _idempotencyKey, signal): Promise<StepResult> => {
    const r = await generateText({
      model,
      instructions: messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n") || undefined,
      messages: toModelMessages(messages),
      tools,
      maxOutputTokens,
      abortSignal: signal,
      maxRetries: 0, // retries would be hidden paid calls; the caller decides
    });
    const { inputTokens, outputTokens } = r.usage;
    // Fail closed: unknown usage cannot be settled honestly; the intent stays pending and the stage parks.
    if (inputTokens === undefined || outputTokens === undefined) throw new Error("provider returned no token usage");
    return {
      text: r.text,
      toolCalls: r.toolCalls.map((c) => ({ id: c.toolCallId, name: c.toolName, args: c.input })),
      usage: { inputTokens, outputTokens },
    };
  };
}
