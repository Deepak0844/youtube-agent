"use server";

import { redirect } from "next/navigation";
import { refresh } from "next/cache";
import { assertActionOrigin } from "@/lib/auth/action-origin";
import { requireOwner } from "@/lib/auth/require-owner";
import { parseEpisodeList, parseSeriesForm } from "@/server/core/series";
import { getPool } from "@/server/db/pool";
import { createSeries, dropPart, movePart, planParts, startPart } from "@/server/db/series";
import { webStageQueue } from "@/server/queue/web-queues";

export interface SeriesFormState {
  ok?: boolean;
  error?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const text = (f: FormData, k: string): string => (typeof f.get(k) === "string" ? (f.get(k) as string) : "");
const partNo = (f: FormData): number | null => {
  const n = Number(text(f, "part"));
  return Number.isInteger(n) && n >= 1 && n <= 1000 ? n : null;
};

// Every action: session first, then the Origin check, then the form. Failures return fixed sentences; typed text is never echoed.
export async function createSeriesAction(_prev: SeriesFormState, form: FormData): Promise<SeriesFormState> {
  const owner = await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return { error: origin };
  const p = parseSeriesForm(form);
  if (!p.ok) return { error: p.message };
  const r = await createSeries(getPool(), { kind: "session", sessionId: owner.sessionId }, p.value);
  if (!r.ok) return { error: r.message };
  redirect(`/series/${r.id}`);
}

export async function planPartsAction(_prev: SeriesFormState, form: FormData): Promise<SeriesFormState> {
  await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return { error: origin };
  const id = text(form, "id");
  if (!UUID.test(id)) return { error: "That series was not found." };
  const eps = parseEpisodeList(text(form, "episodes"));
  if (!eps.ok) return { error: eps.message };
  const r = await planParts(getPool(), id, eps.value);
  if (!r.ok) return { error: r.message };
  refresh();
  return { ok: true };
}

export async function movePartAction(_prev: SeriesFormState, form: FormData): Promise<SeriesFormState> {
  await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return { error: origin };
  const id = text(form, "id");
  const n = partNo(form);
  const dir = text(form, "dir");
  if (!UUID.test(id) || n === null || (dir !== "up" && dir !== "down")) return { error: "That part is no longer planned." };
  const r = await movePart(getPool(), id, n, dir);
  if (!r.ok) return { error: r.message };
  refresh();
  return { ok: true };
}

export async function dropPartAction(_prev: SeriesFormState, form: FormData): Promise<SeriesFormState> {
  await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return { error: origin };
  const id = text(form, "id");
  const n = partNo(form);
  if (!UUID.test(id) || n === null) return { error: "That part is no longer planned." };
  const r = await dropPart(getPool(), id, n);
  if (!r.ok) return { error: r.message };
  refresh();
  return { ok: true };
}

// Starts a normal video draft for the part. It stops at its first approval step: nothing is approved or uploaded here.
export async function startPartAction(_prev: SeriesFormState, form: FormData): Promise<SeriesFormState> {
  const owner = await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return { error: origin };
  const id = text(form, "id");
  const n = partNo(form);
  if (!UUID.test(id) || n === null) return { error: "That part is no longer planned." };
  const r = await startPart(getPool(), webStageQueue(), { kind: "session", sessionId: owner.sessionId }, id, n);
  if (!r.ok) return { error: r.message };
  redirect(`/videos/${r.videoId}`);
}
