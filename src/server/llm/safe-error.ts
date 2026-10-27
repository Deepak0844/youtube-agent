import { APICallError } from "ai";
import { NotProcessedError } from "@/server/core/error-class";
import { BlockedAddressError } from "@/server/providers/net/safe-fetch";

// The only way a model-call failure leaves the LLM layer. An SDK error carries the request URL, request body, response
// headers and the provider's response body (several providers echo part of the API key in a 401 body). None of that may
// reach a log, a BullMQ failure, `spend_intents.result`, the audit log or the screen, so NOTHING from the SDK error is
// forwarded: not its message, not its fields, not its cause. The new error has a fixed sentence chosen from what we can
// prove (status code, connect failure before any byte), and no `cause`.
//
// Money rule (owner): an unclear outcome is never retried. Only a refusal we SAW before any work was done becomes a
// NotProcessedError (a KnownFailure: nothing charged, reservation released). Everything else is a plain Error, which leaves
// the spend intent pending so the stage parks as "needs your decision".

const BEFORE_SEND = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);
// Messages thrown by src/server/llm/model-factory.ts itself, before any request is sent. Trusted only on a plain Error.
const OWN_KEY_MESSAGE = /^(?:No key saved for|Could not read the key for) [A-Za-z0-9 .()/_-]{1,60}$/;

const STATUS_TEXT: Record<number, string> = {
  400: "The provider rejected the request (400).",
  401: "The provider rejected the key (401). Check the key on the Keys page.",
  403: "The provider refused access (403). Check the key and the model.",
  404: "The provider does not know this model or address (404). Check the model id.",
  422: "The provider could not process the request (422).",
  429: "The provider is rate limiting this key (429). Try again later.",
};

function chain(err: unknown): unknown[] {
  const out: unknown[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 6 && cur !== undefined && cur !== null; i++) {
    out.push(cur);
    cur = typeof cur === "object" ? (cur as { cause?: unknown }).cause : undefined;
  }
  return out;
}

const codeOf = (e: unknown): string | undefined => {
  const c = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
  return typeof c === "string" ? c : undefined;
};

/** Returns the error the rest of the app may see. Never throws, never returns anything built from SDK text. */
export function toSafeModelError(err: unknown): Error {
  try {
    const links = chain(err);

    for (const e of links) {
      if (e instanceof Error && e.constructor === Error && OWN_KEY_MESSAGE.test(e.message)) return new NotProcessedError(e.message);
      if (e instanceof BlockedAddressError) return new NotProcessedError("The model address is not allowed by the network guard.");
    }

    const api = links.find((e) => APICallError.isInstance(e)) as APICallError | undefined;
    const status = api?.statusCode;
    if (status !== undefined) {
      if (status >= 400 && status <= 499 && status !== 408) {
        return new NotProcessedError(STATUS_TEXT[status] ?? `The provider rejected the request (${status}).`, { status });
      }
      return new Error(`The provider answered with an error (${status}). It may or may not have charged for the call.`);
    }

    for (const e of links) {
      const code = codeOf(e);
      if (code !== undefined && BEFORE_SEND.has(code)) return new NotProcessedError("Could not reach the model server.", { code });
    }

    for (const e of links) {
      if (e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError")) {
        return new Error("The model call was stopped before it finished. It may or may not have charged for the call.");
      }
    }
  } catch {
    // fall through: even a hostile error object only ever produces the generic sentence
  }
  return new Error("The model call failed.");
}
