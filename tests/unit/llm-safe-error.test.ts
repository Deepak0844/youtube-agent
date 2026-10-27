import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { KnownFailure } from "@/server/core/paid-call";
import { classifyError, NotProcessedError } from "@/server/core/error-class";
import { createAiSdkStep } from "@/server/llm/ai-sdk-step";
import { BlockedAddressError } from "@/server/providers/net/safe-fetch";

// A key the provider "echoes" in every place an SDK error carries request or response text.
const KEY = "sk-ant-api03-LEAKCANARY0123456789abcdefghijklmnop";

const apiError = (statusCode: number | undefined, extra: Record<string, unknown> = {}) =>
  new APICallError({
    message: `Incorrect API key provided: ${KEY}`,
    url: `https://api.example.com/v1/chat?key=${KEY}`,
    requestBodyValues: { headers: { authorization: `Bearer ${KEY}` } },
    statusCode,
    responseHeaders: { "x-echo": KEY },
    responseBody: JSON.stringify({ error: { message: `bad key ${KEY}` } }),
    ...extra,
  });

const failing = (err: unknown) => new MockLanguageModelV4({ doGenerate: async () => Promise.reject(err) });
const run = async (err: unknown): Promise<Error> => {
  const step = createAiSdkStep(failing(err), [], 10);
  try {
    await step([{ role: "user", content: "go" }], "k");
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected the step to throw");
};
// Everything a logger, a DB column or the UI could serialise out of the error.
function everything(e: Error): string {
  const seen = new Set<unknown>();
  const parts: string[] = [];
  const walk = (x: unknown, depth: number): void => {
    if (depth > 6 || x === null || x === undefined || seen.has(x)) return;
    if (typeof x === "string") return void parts.push(x);
    if (typeof x !== "object") return void parts.push(String(x));
    seen.add(x);
    for (const k of Object.getOwnPropertyNames(x)) walk((x as Record<string, unknown>)[k], depth + 1);
  };
  walk(e, 0);
  parts.push(String(e.stack), e.message, JSON.stringify(e), String(e));
  return parts.join("\n");
}

describe("model errors are redacted", () => {
  it("sdk_error_with_key_in_url_body_and_headers_leaks_nothing", async () => {
    for (const status of [400, 401, 403, 404, 429, 500, 503, undefined]) {
      const e = await run(apiError(status));
      expect(everything(e)).not.toContain(KEY);
      expect(everything(e)).not.toContain("LEAKCANARY");
      expect(everything(e)).not.toContain("api.example.com");
      expect(e.cause).toBeUndefined();
    }
  });

  it("a_cause_chain_carrying_the_key_is_dropped", async () => {
    const inner = new Error(`socket said ${KEY}`);
    const e = await run(Object.assign(new Error(`wrapped ${KEY}`), { cause: inner, responseBody: KEY }));
    expect(everything(e)).not.toContain("LEAKCANARY");
  });

  it("client_rejections_are_known_failures_with_a_plain_reason", async () => {
    for (const status of [400, 401, 403, 404, 422, 429]) {
      const e = await run(apiError(status));
      expect(e).toBeInstanceOf(KnownFailure);
      expect(e).toBeInstanceOf(NotProcessedError);
      expect(e.message).toMatch(new RegExp(String(status)));
    }
    expect((await run(apiError(401))).message).toMatch(/key/i);
    expect(classifyError(await run(apiError(429)))).toBe("transient");
    expect(classifyError(await run(apiError(401)))).toBe("permanent");
  });

  it("server_errors_and_unknown_failures_are_unclear_outcomes_never_known", async () => {
    for (const status of [408, 500, 502, 503, 529, undefined]) {
      const e = await run(apiError(status));
      expect(e).not.toBeInstanceOf(KnownFailure);
      expect(classifyError(e)).toBe("unknown");
    }
    const generic = await run(new Error(`boom ${KEY}`));
    expect(generic).not.toBeInstanceOf(KnownFailure);
    expect(generic.message).toBe("The model call failed.");
  });

  it("an_abort_is_an_unclear_outcome", async () => {
    const e = await run(Object.assign(new Error(`aborted ${KEY}`), { name: "AbortError" }));
    expect(e).not.toBeInstanceOf(KnownFailure);
    expect(everything(e)).not.toContain("LEAKCANARY");
    expect(e.message).toMatch(/stopped/i);
  });

  it("connection_refused_before_any_byte_is_a_known_failure", async () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), { code: "ECONNREFUSED" });
    const e = await run(apiError(undefined, { cause: new TypeError("fetch failed", { cause: refused }) }));
    expect(e).toBeInstanceOf(NotProcessedError);
    expect(classifyError(e)).toBe("transient");
    expect(everything(e)).not.toContain("127.0.0.1");
  });

  it("our_own_missing_key_message_survives_as_a_known_failure", async () => {
    const e = await run(new Error("No key saved for OpenAI"));
    expect(e).toBeInstanceOf(KnownFailure);
    expect(e.message).toBe("No key saved for OpenAI");
    const wrapped = await run(apiError(undefined, { cause: new TypeError("fetch failed", { cause: new Error("Could not read the key for Groq.") }) }));
    expect(wrapped.message).toBe("Could not read the key for Groq.");
  });

  it("a_blocked_address_is_a_known_failure_without_the_address", async () => {
    const e = await run(new BlockedAddressError("10.0.0.7", "private"));
    expect(e).toBeInstanceOf(KnownFailure);
    expect(everything(e)).not.toContain("10.0.0.7");
  });

  it("a_look_alike_message_from_an_sdk_error_is_not_trusted", async () => {
    const e = await run(apiError(500, { message: "No key saved for Attacker" }));
    expect(e).not.toBeInstanceOf(KnownFailure);
  });
});
