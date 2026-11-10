"use server";

import { refresh } from "next/cache";
import { assertActionOrigin } from "@/lib/auth/action-origin";
import { requireOwner } from "@/lib/auth/require-owner";
import { BAD_FORM, parseIdForm } from "@/server/core/queue-input";
import { getPool } from "@/server/db/pool";
import { startVersion } from "@/server/db/video-create";
import { webStageQueue } from "@/server/queue/web-queues";

// "Make another version" on a Short's page. Same guard order as the other video page actions: requireOwner, Origin check, then the form.
// It starts a NEW video like the New form does (the same caps and checks); nothing of this video is changed.
export type VersionState = { ok?: boolean; message?: string; videoId?: string };

export async function makeVersionAction(_prev: VersionState, form: FormData): Promise<VersionState> {
  const owner = await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return { ok: false, message: origin };
  const id = parseIdForm(form, "videoId");
  if (!id.ok) return { ok: false, message: BAD_FORM };
  let r;
  try {
    r = await startVersion(getPool(), webStageQueue(), { kind: "session", sessionId: owner.sessionId }, id.value, form.get("kind"));
  } catch {
    return { ok: false, message: "Could not start the video. Nothing was saved. Try again in a minute." };
  }
  refresh();
  return r.ok ? { ok: true, message: "Started. Open it to follow its progress.", videoId: r.videoId } : { ok: false, message: r.message };
}
