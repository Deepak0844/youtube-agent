"use server";

import { refresh } from "next/cache";
import { assertActionOrigin } from "@/lib/auth/action-origin";
import { requireOwner } from "@/lib/auth/require-owner";
import { LIVE_PHRASE } from "@/server/core/comments";
import { BAD_FORM, parseIdForm } from "@/server/core/queue-input";
import { editReply, ignoreComment, postReply, requestReplyDrafts, resolveReply, syncComments, syncMessage } from "@/server/db/comments";
import { loadKeyring } from "@/server/db/master-key";
import { getPool } from "@/server/db/pool";
import { saveUploadSwitches } from "@/server/db/system-settings";
import { defaultGoogleHttp } from "@/server/db/youtube-channels";
import { webStageQueue } from "@/server/queue/web-queues";

export interface EngagementState {
  ok?: boolean;
  message?: string;
}

// Every action here: requireOwner first, then the same-origin check, then the form. The signed-in owner session is the ONLY actor
// that can post a reply (the data layer refuses anything else again). Nothing here posts more than the one reply in the form.

const SEEN = /^[0-9a-f]{64}$/;

export async function syncCommentsAction(): Promise<EngagementState> {
  const owner = await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return { ok: false, message: origin };
  try {
    const r = await syncComments(getPool(), loadKeyring, defaultGoogleHttp, { kind: "session", sessionId: owner.sessionId }, { queue: webStageQueue() });
    refresh();
    return { ok: r.failed === 0 && !r.quotaStopped, message: syncMessage(r) };
  } catch {
    return { ok: false, message: "The sync could not finish. Nothing was changed on YouTube. Try again." };
  }
}

export async function draftRepliesAction(_prev: EngagementState, form: FormData): Promise<EngagementState> {
  const owner = await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return { ok: false, message: origin };
  const id = parseIdForm(form, "videoId");
  if (!id.ok) return { ok: false, message: BAD_FORM };
  const r = await requestReplyDrafts(getPool(), webStageQueue(), id.value, owner.sessionId);
  refresh();
  return r.ok ? { ok: true, message: "Queued. The drafts appear here in a minute or two, held for your review." } : { ok: false, message: r.message };
}

export async function approveAndPostAction(_prev: EngagementState, form: FormData): Promise<EngagementState> {
  const owner = await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return { ok: false, message: origin };
  const id = parseIdForm(form, "replyId");
  const seen = form.get("seen");
  const expectMode = form.get("expectMode");
  if (!id.ok || typeof seen !== "string" || !SEEN.test(seen) || (expectMode !== "dry" && expectMode !== "live")) return { ok: false, message: BAD_FORM };
  const r = await postReply(getPool(), loadKeyring, defaultGoogleHttp, { replyId: id.value, seen, ack: form.get("ack") === "on", expectMode, actor: { kind: "session", sessionId: owner.sessionId } });
  refresh();
  if (!r.ok) return { ok: false, message: r.message };
  return { ok: true, message: r.outcome === "dry_run" ? "Dry run: the request was recorded and nothing was sent to YouTube." : "Posted to YouTube." };
}

export async function editReplyAction(_prev: EngagementState, form: FormData): Promise<EngagementState> {
  const owner = await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return { ok: false, message: origin };
  const id = parseIdForm(form, "replyId");
  const text = form.get("text");
  if (!id.ok || typeof text !== "string" || text.length > 5000) return { ok: false, message: BAD_FORM };
  const r = await editReply(getPool(), id.value, text, { kind: "session", sessionId: owner.sessionId });
  refresh();
  return r.ok ? { ok: true, message: "Saved. Look at it again before approving." } : { ok: false, message: r.message };
}

export async function ignoreCommentAction(_prev: EngagementState, form: FormData): Promise<EngagementState> {
  const owner = await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return { ok: false, message: origin };
  const id = parseIdForm(form, "commentId");
  if (!id.ok) return { ok: false, message: BAD_FORM };
  const r = await ignoreComment(getPool(), id.value, { kind: "session", sessionId: owner.sessionId });
  refresh();
  return r.ok ? { ok: true, message: "Ignored." } : { ok: false, message: r.message };
}

/** "I checked YouTube": settles an unclear or stuck reply by hand. Sends nothing. */
export async function resolveReplyAction(_prev: EngagementState, form: FormData): Promise<EngagementState> {
  const owner = await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return { ok: false, message: origin };
  const id = parseIdForm(form, "replyId");
  const outcome = form.get("outcome");
  if (!id.ok || (outcome !== "posted" && outcome !== "ignored")) return { ok: false, message: BAD_FORM };
  const r = await resolveReply(getPool(), id.value, outcome, { kind: "session", sessionId: owner.sessionId });
  refresh();
  return r.ok ? { ok: true, message: "Marked." } : { ok: false, message: r.message };
}

/** Safety switch. Turning dry run OFF (replies really post) needs the typed phrase; turning it back ON is one click. */
export async function setDryRunAction(_prev: EngagementState, form: FormData): Promise<EngagementState> {
  await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return { ok: false, message: origin };
  const dry = form.get("dry") === "on";
  const typed = form.get("typed");
  if (!dry && (typeof typed !== "string" || typed !== LIVE_PHRASE)) return { ok: false, message: `Type ${LIVE_PHRASE} exactly to turn dry run off. Nothing was saved.` };
  const r = await saveUploadSwitches(getPool(), { commentsDryRun: dry, typedLive: typeof typed === "string" ? typed : undefined });
  refresh();
  return r.ok ? { ok: true, message: dry ? "Dry run is on: nothing is posted to YouTube." : "Dry run is off: Approve and post now really posts." } : { ok: false, message: r.error };
}
