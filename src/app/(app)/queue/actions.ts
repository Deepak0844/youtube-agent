"use server";

import { refresh } from "next/cache";
import { notFound } from "next/navigation";
import { assertActionOrigin } from "@/lib/auth/action-origin";
import { requireOwner } from "@/lib/auth/require-owner";
import { dryRunAllowed } from "@/lib/dry-run";
import { BAD_FORM, parseDecisionForm, parseGateForm, parseIdForm, parseStageForm } from "@/server/core/queue-input";
import { getPool } from "@/server/db/pool";
import { cancelVideoById, decideGate, decideParkedStage, resetBreakerFor, sendUploadAgain, startDryRun, type ActionResult } from "@/server/db/queue-actions";
import { webStageQueue, webUploadQueue } from "@/server/queue/web-queues";

// Every action: requireOwner() first (the session id comes from it and from nowhere else), then the Origin check, then
// the form is parsed, then the core (db/queue-actions.ts) compares what the page rendered with the live state. Whatever
// happens the page is refreshed, so a stale card is replaced by the current one. Failures return fixed sentences.
export type QueueState = Partial<ActionResult>;

const queues = () => ({ stage: webStageQueue(), upload: webUploadQueue() });
const done = (r: QueueState): QueueState => {
  refresh();
  return r;
};
const bad = (message: string): QueueState => ({ ok: false, message });

export async function approveGateAction(_prev: QueueState, form: FormData): Promise<QueueState> {
  const owner = await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return bad(origin);
  const p = parseGateForm(form, "approve");
  if (!p.ok) return done(bad(p.message));
  return done(await decideGate(getPool(), queues(), { kind: "session", sessionId: owner.sessionId }, p.value, "approve"));
}

export async function sendBackAction(_prev: QueueState, form: FormData): Promise<QueueState> {
  const owner = await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return bad(origin);
  const p = parseGateForm(form, "send_back");
  if (!p.ok) return bad(p.message); // a short note keeps what was typed: no refresh
  return done(await decideGate(getPool(), queues(), { kind: "session", sessionId: owner.sessionId }, p.value, "send_back"));
}

export async function resolveDecisionAction(_prev: QueueState, form: FormData): Promise<QueueState> {
  const owner = await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return bad(origin);
  const p = parseDecisionForm(form);
  if (!p.ok) return done(bad(p.message));
  return done(await decideParkedStage(getPool(), queues(), { kind: "session", sessionId: owner.sessionId }, p.value));
}

export async function resetBreakerAction(_prev: QueueState, form: FormData): Promise<QueueState> {
  const owner = await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return bad(origin);
  const p = parseStageForm(form);
  if (!p.ok) return bad(BAD_FORM);
  return done(await resetBreakerFor(getPool(), { kind: "session", sessionId: owner.sessionId }, p.value));
}

export async function requeueUploadAction(_prev: QueueState, form: FormData): Promise<QueueState> {
  const owner = await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return bad(origin);
  const p = parseIdForm(form, "uploadId");
  if (!p.ok) return bad(p.message);
  return done(await sendUploadAgain(getPool(), queues(), { kind: "session", sessionId: owner.sessionId }, p.value));
}

export async function cancelVideoAction(_prev: QueueState, form: FormData): Promise<QueueState> {
  const owner = await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return bad(origin);
  const p = parseIdForm(form, "videoId");
  if (!p.ok) return bad(p.message);
  return done(await cancelVideoById(getPool(), { kind: "session", sessionId: owner.sessionId }, p.value));
}

export async function startDryRunAction(): Promise<QueueState> {
  const owner = await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return bad(origin);
  if (!dryRunAllowed()) notFound(); // a production build without ENGINE_DRY_RUN=1 behaves as if this did not exist
  return done(await startDryRun(getPool(), queues(), { kind: "session", sessionId: owner.sessionId }));
}
