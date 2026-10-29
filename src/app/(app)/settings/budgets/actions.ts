"use server";

import { refresh } from "next/cache";
import { requireOwner } from "@/lib/auth/require-owner";
import { dollarsToMicro } from "@/server/core/spend";
import { setBudgetCap } from "@/server/db/budget-scopes";
import { getPool } from "@/server/db/pool";

// Session-only (requireOwner first); the data layer re-checks the actor and the template list. Answers are fixed sentences.
export interface CapActionState {
  scope?: string;
  kind?: "saved" | "error";
  message?: string;
  n?: number; // changes on every answer so identical consecutive messages are still announced
}

const reply = (scope: string, s: Omit<CapActionState, "scope" | "n">): CapActionState => ({ scope, n: Date.now(), ...s });
const field = (form: FormData, name: string, max: number): string | null => {
  const v = form.get(name);
  return typeof v === "string" && v.length <= max ? v : null;
};

export async function saveCapAction(_prev: CapActionState, form: FormData): Promise<CapActionState> {
  await requireOwner();
  const scope = field(form, "scope", 40) ?? "";
  const unlimited = form.get("unlimited") === "on";
  const dollars = field(form, "dollars", 20);
  let cap: number | null = null;
  if (!unlimited) {
    cap = dollars === null ? null : dollarsToMicro(dollars);
    if (cap === null) return reply(scope, { kind: "error", message: "Enter a limit in dollars, such as 2 or 2.50. Nothing was saved." });
  }
  try {
    await setBudgetCap(getPool(), scope, cap, "session");
  } catch (e) {
    return reply(scope, {
      kind: "error",
      message: e instanceof RangeError ? "That limit is not allowed (up to $1,000,000). Nothing was saved." : "Could not save the limit. Nothing was changed.",
    });
  }
  refresh();
  return reply(scope, { kind: "saved", message: unlimited ? "Saved. No limit." : "Saved." });
}
