"use server";

import { redirect } from "next/navigation";
import { assertActionOrigin } from "@/lib/auth/action-origin";
import { requireOwner } from "@/lib/auth/require-owner";
import { parseNewVideoForm } from "@/server/core/videos-view";
import { getPool } from "@/server/db/pool";
import { startNewVideo } from "@/server/db/video-create";
import { webStageQueue } from "@/server/queue/web-queues";

export interface NewVideoState {
  message?: string;
}

// Session first, then the Origin check, then the form is parsed. Failures return a fixed sentence; nothing is echoed back.
export async function createVideoAction(_prev: NewVideoState, form: FormData): Promise<NewVideoState> {
  const owner = await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return { message: origin };
  const p = parseNewVideoForm(form);
  if (!p.ok) return { message: p.message };
  let r;
  try {
    r = await startNewVideo(getPool(), webStageQueue(), { kind: "session", sessionId: owner.sessionId }, p.value);
  } catch {
    return { message: "Could not start the video. Nothing was saved. Try again in a minute." };
  }
  if (!r.ok) return { message: r.message };
  redirect(`/videos/${r.videoId}`);
}
