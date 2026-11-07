"use server";

import { redirect } from "next/navigation";
import { refresh } from "next/cache";
import { assertActionOrigin } from "@/lib/auth/action-origin";
import { requireOwner } from "@/lib/auth/require-owner";
import { parseIdeaForm } from "@/server/core/ideas";
import { addIdea, dismissIdea, draftIdea } from "@/server/db/ideas";
import { getPool } from "@/server/db/pool";
import { webStageQueue } from "@/server/queue/web-queues";

export interface IdeaFormState {
  ok?: boolean;
  error?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const text = (f: FormData, k: string): string => (typeof f.get(k) === "string" ? (f.get(k) as string) : "");

// Every action: session first, then the Origin check, then the form. Failures return fixed sentences; idea text is never echoed.
export async function addIdeaAction(_prev: IdeaFormState, form: FormData): Promise<IdeaFormState> {
  const owner = await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return { error: origin };
  const p = parseIdeaForm(form);
  if (!p.ok) return { error: p.message };
  const channel = text(form, "channel");
  if (channel && !/^[A-Za-z0-9_-]{1,64}$/.test(channel)) return { error: "Pick a channel from the list." };
  const r = await addIdea(getPool(), { kind: "session", sessionId: owner.sessionId }, p.value, channel || null);
  if (!r.ok) return { error: r.message };
  refresh();
  return { ok: true };
}

export async function dismissIdeaAction(_prev: IdeaFormState, form: FormData): Promise<IdeaFormState> {
  const owner = await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return { error: origin };
  const id = text(form, "id");
  if (!UUID.test(id)) return { error: "That idea is no longer waiting." };
  const r = await dismissIdea(getPool(), { kind: "session", sessionId: owner.sessionId }, id);
  if (!r.ok) return { error: r.message };
  refresh();
  return { ok: true };
}

// Starts a normal video and opens it. The video stops at its first approval step: nothing is approved or uploaded here.
export async function draftIdeaAction(_prev: IdeaFormState, form: FormData): Promise<IdeaFormState> {
  const owner = await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return { error: origin };
  const id = text(form, "id");
  if (!UUID.test(id)) return { error: "That idea is no longer waiting." };
  const r = await draftIdea(getPool(), webStageQueue(), { kind: "session", sessionId: owner.sessionId }, id, { kind: text(form, "kind"), language: text(form, "language") });
  if (!r.ok) return { error: r.message };
  redirect(`/videos/${r.videoId}`);
}
