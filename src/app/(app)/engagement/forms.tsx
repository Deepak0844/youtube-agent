"use client";

import { useActionState } from "react";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { Label } from "@/ui/primitives/label";
import { approveAndPostAction, draftRepliesAction, editReplyAction, ignoreCommentAction, resolveReplyAction, setDryRunAction, syncCommentsAction, type EngagementState } from "./actions";

function Result({ state }: { state: EngagementState }) {
  if (!state.message) return null;
  return (
    <p role={state.ok ? "status" : "alert"} className={state.ok ? "m-0 text-body text-pill-positive-ink" : "m-0 text-body text-pill-negative-ink"}>
      {state.message}
    </p>
  );
}

export function SyncForm() {
  const [state, run, pending] = useActionState<EngagementState, FormData>(() => syncCommentsAction(), {});
  return (
    <form action={run} className="flex flex-wrap items-center gap-3">
      <Button type="submit" loading={pending}>
        {pending ? "Reading…" : "Run now"}
      </Button>
      <Result state={state} />
    </form>
  );
}

export function DraftForm({ videoId }: { videoId: string }) {
  const [state, run, pending] = useActionState<EngagementState, FormData>(draftRepliesAction, {});
  return (
    <form action={run} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="videoId" value={videoId} />
      <Button type="submit" variant="secondary" loading={pending}>
        Draft replies for new comments
      </Button>
      <Result state={state} />
    </form>
  );
}

/** Approve and post: ONE reply. `seen` is the hash of the comment and reply text this page shows; the server refuses if either changed. */
export function ApproveForm({ replyId, seen, needsEyes, dryRun }: { replyId: string; seen: string; needsEyes: boolean; dryRun: boolean }) {
  const [state, run, pending] = useActionState<EngagementState, FormData>(approveAndPostAction, {});
  return (
    <form action={run} className="flex flex-col gap-2">
      <input type="hidden" name="replyId" value={replyId} />
      <input type="hidden" name="seen" value={seen} />
      <input type="hidden" name="expectMode" value={dryRun ? "dry" : "live"} />
      {needsEyes ? (
        <label className="flex min-h-11 items-center gap-3 text-body">
          <input type="checkbox" name="ack" className="size-5 accent-[var(--text)]" />
          I read this comment myself
        </label>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" loading={pending}>
          {pending ? "Working…" : "Approve and post"}
        </Button>
        <Result state={state} />
      </div>
    </form>
  );
}

export function EditForm({ replyId, text }: { replyId: string; text: string }) {
  const [state, run, pending] = useActionState<EngagementState, FormData>(editReplyAction, {});
  return (
    <details className="text-body">
      <summary className="min-h-11 cursor-pointer py-2">Edit</summary>
      <form action={run} className="flex flex-col gap-2">
        <input type="hidden" name="replyId" value={replyId} />
        <Label htmlFor={`edit-${replyId}`}>Reply text (plain text, up to 500 characters)</Label>
        <textarea id={`edit-${replyId}`} name="text" defaultValue={text} rows={3} maxLength={500} className="w-full rounded-control border border-border bg-surface p-2 text-body" />
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="secondary" loading={pending}>
            Save edit
          </Button>
          <Result state={state} />
        </div>
      </form>
    </details>
  );
}

/** For a failed (unclear) or stuck reply: the owner looked at YouTube and says what is there. Sends nothing. */
export function ResolveForm({ replyId }: { replyId: string }) {
  const [state, run, pending] = useActionState<EngagementState, FormData>(resolveReplyAction, {});
  return (
    <form action={run} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="replyId" value={replyId} />
      <Button type="submit" name="outcome" value="posted" variant="secondary" loading={pending}>
        I checked YouTube: it is posted
      </Button>
      <Button type="submit" name="outcome" value="ignored" variant="secondary" loading={pending}>
        I checked YouTube: not posted, drop it
      </Button>
      <Result state={state} />
    </form>
  );
}

export function IgnoreForm({ commentId }: { commentId: string }) {
  const [state, run, pending] = useActionState<EngagementState, FormData>(ignoreCommentAction, {});
  return (
    <form action={run} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="commentId" value={commentId} />
      <Button type="submit" variant="secondary" loading={pending}>
        Ignore
      </Button>
      <Result state={state} />
    </form>
  );
}

export function DryRunForm({ dryRun, phrase }: { dryRun: boolean; phrase: string }) {
  const [state, run, pending] = useActionState<EngagementState, FormData>(setDryRunAction, {});
  return (
    <form action={run} className="flex flex-col gap-3">
      <label className="flex min-h-11 items-center gap-3 text-body">
        <input type="checkbox" name="dry" defaultChecked={dryRun} className="size-5 accent-[var(--text)]" />
        Dry run (nothing is posted to YouTube)
      </label>
      <div className="flex min-w-0 flex-col gap-2">
        <Label htmlFor="typed">To turn dry run off, untick the box and type {phrase}</Label>
        <Input id="typed" name="typed" autoComplete="off" spellCheck={false} />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="secondary" loading={pending}>
          Save
        </Button>
        <Result state={state} />
      </div>
    </form>
  );
}
