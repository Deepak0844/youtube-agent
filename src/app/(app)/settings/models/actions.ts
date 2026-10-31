"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { assertActionOrigin } from "@/lib/auth/action-origin";
import { requireOwner } from "@/lib/auth/require-owner";
import { parseAiSourceForm } from "@/server/core/ai-source";
import { setAiSource, testClaudeCodeConnection } from "@/server/db/claude-code";
import { InputTooLongError, boundedText, usdToMicro } from "@/server/core/llm-catalog";
import { CatalogError, copyDefault, createModel, deleteModel, setRoute, updateModel } from "@/server/db/llm-models";
import { getPool } from "@/server/db/pool";
import { loadKeyring } from "@/server/db/master-key";
import { testModel } from "@/server/db/llm-test";
import { defaultModelDeps } from "@/server/llm/default-deps";

// Every action: requireOwner() first, zod parse, db function (session actor), one audit row inside it, then refresh().
// Errors the owner can act on (CatalogError) are shown as written; everything else is one generic sentence, so no SQL,
// constraint name or stack reaches the browser. API keys are not handled on this page at all.

export interface FormState {
  ok?: boolean;
  error?: string;
  /** A short result line to show (the Test button); fixed sentences only. */
  note?: string;
  /** Plain lines from the AI source switch (which stages stay on their API model, and why). */
  notes?: string[];
  /** What the owner typed, handed back on error so React's form reset does not wipe it. Nothing secret lives on this page. */
  fields?: Record<string, string>;
}

const GENERIC = "Could not save. Nothing was changed. Try again.";
const echo = (form: FormData): Record<string, string> =>
  Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === "string").map(([k, v]) => [k, (v as string).slice(0, 300)]));
const fail = (err: unknown, form: FormData): FormState => {
  const fields = echo(form);
  if (err instanceof CatalogError) return { error: err.message, fields };
  if (err instanceof InputTooLongError) return { error: err.message, fields };
  console.error(JSON.stringify({ event: "models.action_failed", name: err instanceof Error ? err.name : "unknown" }));
  return { error: GENERIC, fields };
};

const idField = z.string().max(64);
const text = boundedText;
const checked = (v: FormDataEntryValue | null): boolean => v === "on";

// Dollars per million tokens as typed -> integer micro-USD. Empty = not given. Anything unreadable stays NaN, which the
// price schema refuses.
function usd(form: FormData, name: string): number | undefined {
  const t = text(form.get(name), 20).trim().replace(/^\$/, "");
  if (t === "") return undefined;
  return usdToMicro(t) ?? Number.NaN;
}

function modelFromForm(form: FormData): unknown {
  const price = {
    inputPerMTokMicro: usd(form, "inputUsd"),
    outputPerMTokMicro: usd(form, "outputUsd"),
    cacheWritePerMTokMicro: usd(form, "cacheWriteUsd"),
    cacheReadPerMTokMicro: usd(form, "cacheReadUsd"),
    reasoningPerMTokMicro: usd(form, "reasoningUsd"),
    perCallMicro: usd(form, "perCallUsd"),
  };
  const anyPrice = Object.values(price).some((v) => v !== undefined);
  const isFree = checked(form.get("isFree"));
  const baseUrl = text(form.get("baseUrl"), 300).trim();
  return {
    provider: text(form.get("provider"), 40),
    modelId: text(form.get("modelId"), 200),
    label: text(form.get("label"), 100),
    baseUrl: baseUrl === "" ? null : baseUrl,
    prices: anyPrice && !isFree ? Object.fromEntries(Object.entries(price).filter(([, v]) => v !== undefined)) : null,
    isFree,
    capabilities: {
      structuredOutput: checked(form.get("structuredOutput")),
      toolUse: checked(form.get("toolUse")),
      vision: checked(form.get("vision")),
      nativeWebSearch: checked(form.get("nativeWebSearch")),
      contextWindow: Number(text(form.get("contextWindow"), 12)),
    },
    enabled: checked(form.get("enabled")),
  };
}

export async function saveModelAction(_prev: FormState, form: FormData): Promise<FormState> {
  await requireOwner();
  try {
    const id = idField.parse(text(form.get("rowId"), 64));
    const raw = modelFromForm(form);
    if (id === "") await createModel(getPool(), raw, { actor: "session" });
    else await updateModel(getPool(), id, raw, { actor: "session" });
  } catch (err) {
    return fail(err, form);
  }
  refresh();
  return { ok: true };
}

export async function deleteModelAction(_prev: FormState, form: FormData): Promise<FormState> {
  await requireOwner();
  try {
    await deleteModel(getPool(), idField.parse(text(form.get("rowId"), 64)), { actor: "session" });
  } catch (err) {
    return fail(err, form);
  }
  refresh();
  return { ok: true };
}

export async function copyDefaultAction(_prev: FormState, form: FormData): Promise<FormState> {
  await requireOwner();
  try {
    await copyDefault(getPool(), idField.parse(text(form.get("rowId"), 64)), { actor: "session" });
  } catch (err) {
    return fail(err, form);
  }
  refresh();
  return { ok: true };
}

export async function setRouteAction(_prev: FormState, form: FormData): Promise<FormState> {
  await requireOwner();
  try {
    const stage = z.string().min(1).max(40).parse(text(form.get("stage"), 40));
    const model = text(form.get("modelId"), 64);
    await setRoute(getPool(), stage, model === "" ? null : model, { actor: "session" });
  } catch (err) {
    return fail(err, form);
  }
  refresh();
  return { ok: true };
}

// The Test button. It can spend real money (a fraction of a cent, capped per day), so everything that limits it lives in
// testModel (session check, price check, reservation, daily cap, cooldown, audit). This action only authenticates first,
// wires the vault and the model factory, and shows the fixed result sentence.
export async function testModelAction(_prev: FormState, form: FormData): Promise<FormState> {
  await requireOwner();
  try {
    const id = idField.parse(text(form.get("rowId"), 64));
    const db = getPool();
    const r = await testModel(db, id, { kind: "session" }, await defaultModelDeps(db, loadKeyring));
    refresh();
    return r.ok ? { ok: true, note: r.message } : { ok: false, error: r.message };
  } catch (err) {
    return fail(err, form);
  }
}

// The AI source switch. Turning it on lets text stages start the claude program on this Mac, so: session first, a strict
// Origin check (a missing Origin is refused too), the exact confirmation tick, then one transaction in setAiSource.
export async function setAiSourceAction(_prev: FormState, form: FormData): Promise<FormState> {
  await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return { error: origin };
  const p = parseAiSourceForm(form);
  if (!p.ok) return { error: p.message };
  try {
    const notes = await setAiSource(getPool(), p.on, { actor: "session" });
    refresh();
    return { ok: true, notes };
  } catch (err) {
    return fail(err, new FormData());
  }
}

// Test connection: one tiny call through the same adapter (counts toward the daily cap, 10 s server-side cooldown).
// Only a fixed sentence per outcome class comes back; never what the program printed.
export async function testClaudeCodeAction(): Promise<FormState> {
  await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return { error: origin };
  try {
    const r = await testClaudeCodeConnection(getPool(), { kind: "session" });
    refresh();
    return r.ok ? { ok: true, note: r.message } : { ok: false, error: r.message };
  } catch (err) {
    return fail(err, new FormData());
  }
}
