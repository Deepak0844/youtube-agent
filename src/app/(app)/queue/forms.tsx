"use client";

import { useActionState, useState } from "react";
import { Button, type ButtonProps } from "@/ui/primitives/button";
import { Label } from "@/ui/primitives/label";
import { approveGateAction, cancelVideoAction, checkOnYoutubeAction, editOutlineAction, retryUploadAction, savePublishChoiceAction, requeueUploadAction, resetBreakerAction, resolveDecisionAction, sendBackAction, startDryRunAction, type QueueState } from "./actions";

type Act = (prev: QueueState, form: FormData) => Promise<QueueState>;

function Result({ state }: { state: QueueState }) {
  if (!state.message) return <p role="status" className="sr-only" />;
  return (
    <p role={state.ok ? "status" : "alert"} className={state.ok ? "text-body text-pill-positive-ink" : "text-body text-pill-negative-ink"}>
      {state.message}
    </p>
  );
}

/** One button in a form of its own: hidden fields carry exactly what the page rendered. */
function OneButton({ action, fields, label, variant, ariaLabel }: { action: Act; fields: Record<string, string>; label: string; variant?: ButtonProps["variant"]; ariaLabel?: string }) {
  const [state, run, pending] = useActionState<QueueState, FormData>(action, {});
  return (
    <form action={run} className="flex flex-wrap items-center gap-3">
      {Object.entries(fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <Button type="submit" variant={variant} loading={pending} aria-label={ariaLabel}>
        {label}
      </Button>
      <Result state={state} />
    </form>
  );
}

export interface GateFields {
  videoId: string;
  gate: string;
  seenHash: string;
  seenVersions: string;
}

export function GateForms({ fields, approveLabel, canApprove, topic, captionsTick = false }: { fields: GateFields; approveLabel: string; canApprove: boolean; topic: string; captionsTick?: boolean }) {
  const [approved, approve, approving] = useActionState<QueueState, FormData>(approveGateAction, {});
  const [sent, send, sending] = useActionState<QueueState, FormData>(sendBackAction, {});
  // What the owner was looking at when this card first rendered. A refresh that brings new content never swaps the hash the
  // buttons post: the buttons stay off until the owner says they reviewed the new version.
  const [seen, setSeen] = useState(fields);
  const changed = seen.seenHash !== fields.seenHash || seen.seenVersions !== fields.seenVersions;
  const hidden = Object.entries(seen).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />);
  const id = `note-${fields.videoId}-${fields.gate}`;
  return (
    <div className="flex flex-col gap-4">
      {changed ? (
        <div role="alert" data-testid="changed-notice" className="flex max-w-[68ch] flex-col gap-3 rounded-card bg-pill-warning-bg p-4 text-body text-pill-warning-ink">
          <p className="m-0">This changed while you had it open. What you see above is the new version. Review it again before you decide.</p>
          <div>
            <Button type="button" variant="secondary" onClick={() => setSeen(fields)}>
              I reviewed the new version
            </Button>
          </div>
        </div>
      ) : null}
      <form action={approve} className="flex flex-wrap items-center gap-3">
        {hidden}
        {captionsTick ? (
          <label className="flex min-h-11 items-center gap-3 text-body">
            <input type="checkbox" name="captionsChecked" required className="size-5 accent-[var(--text)]" />
            I checked the captions
          </label>
        ) : null}
        <Button type="submit" disabled={approving || !canApprove || changed} aria-label={`${approveLabel}: ${topic}`}>
          {approveLabel}
        </Button>
        <Result state={approved} />
      </form>
      <form action={send} className="flex max-w-[60ch] flex-col gap-2">
        {hidden}
        <Label htmlFor={id}>Send back with a note</Label>
        <textarea
          id={id}
          name="note"
          rows={2}
          minLength={3}
          maxLength={1000}
          required
          placeholder="What should change? (3 to 1000 characters)"
          className="min-h-20 w-full rounded-card border border-control bg-surface p-3 text-body text-text placeholder:text-faint focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-text"
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="secondary" disabled={sending || changed} aria-label={`Send back: ${topic}`}>
            Send back
          </Button>
          <Result state={sent} />
        </div>
      </form>
    </div>
  );
}

export function CancelForm({ videoId, topic }: { videoId: string; topic: string }) {
  return <OneButton action={cancelVideoAction} fields={{ videoId }} label="Cancel video" variant="ghost" ariaLabel={`Cancel video: ${topic}`} />;
}

export function BreakerForm({ stage }: { stage: string }) {
  return <OneButton action={resetBreakerAction} fields={{ stage }} label="Release" variant="secondary" ariaLabel={`Release the ${stage} step`} />;
}

export function RequeueForm({ uploadId, topic }: { uploadId: string; topic: string }) {
  return <OneButton action={requeueUploadAction} fields={{ uploadId }} label="Send again" variant="secondary" ariaLabel={`Send again: ${topic}`} />;
}

export function DryRunForm() {
  return <OneButton action={startDryRunAction} fields={{}} label="Start a dry run" variant="secondary" />;
}

export interface DecisionFields {
  stageRunId: string;
  seenMaxMicroUsd: string;
  seenReason: string;
}

/** One choice = one form. The two that release or count money carry a required "I checked billing" box. */
export function DecisionForm({ fields, choice, label, hint, variant, needsCheck }: { fields: DecisionFields; choice: string; label: string; hint: string; variant: ButtonProps["variant"]; needsCheck: boolean }) {
  const [state, run, pending] = useActionState<QueueState, FormData>(resolveDecisionAction, {});
  const id = `chk-${fields.stageRunId}-${choice}`;
  return (
    <form action={run} className="flex flex-col gap-2 rounded-card bg-raised p-4">
      {Object.entries(fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <input type="hidden" name="choice" value={choice} />
      <p className="m-0 text-body text-muted">{hint}</p>
      {needsCheck ? (
        <label htmlFor={id} className="flex min-h-11 items-center gap-3 text-body">
          <input id={id} type="checkbox" name="checked" required className="size-5 accent-[var(--text)]" />
          I checked the provider&apos;s billing page
        </label>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant={variant} loading={pending}>
          {label}
        </Button>
        <Result state={state} />
      </div>
    </form>
  );
}

export function CheckOnYoutubeForm({ uploadId, topic }: { uploadId: string; topic: string }) {
  return <OneButton action={checkOnYoutubeAction} fields={{ uploadId }} label="Check on YouTube" variant="secondary" ariaLabel={`Check on YouTube: ${topic}`} />;
}

export function RetryUploadForm({ uploadId, topic }: { uploadId: string; topic: string }) {
  return <OneButton action={retryUploadAction} fields={{ uploadId }} label="Send again" variant="secondary" ariaLabel={`Send this upload again: ${topic}`} />;
}

const FIELD = "rounded-control border border-control bg-ground px-3 py-2 text-body";

/**
 * Where and how it goes live. Saving is not approving: it makes a new version of the details, so an earlier approval no longer
 * counts. Times are typed in India time (IST). Public is greyed out unless the channel and the global switches allow it, and
 * needs the word "public" typed.
 */
export function PublishChoiceForm({ videoId, visibility, publishAtIst, channelId, channels, publicOpen }: {
  videoId: string; visibility: string; publishAtIst: string; channelId: string;
  channels: Array<{ channelId: string; title: string; allowPublic: boolean }>; publicOpen: boolean;
}) {
  const [state, run, pending] = useActionState<QueueState, FormData>(savePublishChoiceAction, {});
  const [vis, setVis] = useState(visibility === "unlisted" || visibility === "public" ? visibility : "private");
  const [ch, setCh] = useState(channelId);
  const chan = channels.find((c) => c.channelId === ch);
  const publicOk = publicOpen && chan?.allowPublic === true;
  return (
    <form action={run} data-testid="publish-choice" className="flex min-w-0 max-w-[68ch] flex-col gap-3">
      <input type="hidden" name="videoId" value={videoId} />
      <label className="flex flex-col gap-1 text-body">Channel
        <select name="channelId" value={ch} onChange={(e) => setCh(e.target.value)} className={FIELD} required>
          {ch === "" || !chan ? <option value="">Choose a channel</option> : null}
          {channels.map((c) => <option key={c.channelId} value={c.channelId}>{c.title || c.channelId}</option>)}
        </select>
      </label>
      {channels.length === 0 ? <p className="m-0 text-small text-muted">No connected channel yet. Connect one in Settings, Channels.</p> : null}
      <fieldset className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0">
        <legend className="p-0 text-body font-medium">Visibility</legend>
        <label className="flex items-center gap-2 text-body"><input type="radio" name="visibility" value="private" checked={vis === "private"} onChange={() => setVis("private")} /> Private (only you; can be scheduled)</label>
        <label className="flex items-center gap-2 text-body"><input type="radio" name="visibility" value="unlisted" checked={vis === "unlisted"} onChange={() => setVis("unlisted")} /> Unlisted (anyone with the link)</label>
        <label className="flex items-center gap-2 text-body"><input type="radio" name="visibility" value="public" disabled={!publicOk} checked={vis === "public"} onChange={() => setVis("public")} /> Public (everyone){publicOk ? "" : " - switched off; turn on Allow public for the channel and in settings"}</label>
      </fieldset>
      {vis === "public" ? (
        <label className="flex flex-col gap-1 text-body">Type the word public to confirm
          <input name="typed" autoComplete="off" required pattern="[Pp][Uu][Bb][Ll][Ii][Cc]" className={FIELD} />
        </label>
      ) : null}
      <label className="flex flex-col gap-1 text-body">Go live at (India time, IST; private only; at least 60 minutes from now; leave empty for right after the upload)
        <input name="publishAtIst" type="datetime-local" defaultValue={publishAtIst} disabled={vis !== "private"} className={FIELD} />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="secondary" loading={pending}>Save these choices</Button>
        <Result state={state} />
      </div>
    </form>
  );
}

/**
 * Long videos, outline gate: change chapter titles, one-liners and seconds, then save. Saving makes a NEW outline (any earlier
 * approval no longer counts); the owner reads it again and approves. Nothing is spent. `key` on the form resets the boxes when a
 * new version arrives.
 */
export function OutlineEditForm({ fields, chapters }: { fields: Omit<GateFields, "gate">; chapters: Array<{ title: string; line: string; targetS: number }> }) {
  const [state, run, pending] = useActionState<QueueState, FormData>(editOutlineAction, {});
  return (
    <form key={fields.seenHash} action={run} data-testid="outline-edit" className="flex min-w-0 max-w-[68ch] flex-col gap-4">
      <input type="hidden" name="videoId" value={fields.videoId} />
      <input type="hidden" name="seenHash" value={fields.seenHash} />
      <input type="hidden" name="seenVersions" value={fields.seenVersions} />
      <input type="hidden" name="chapter_count" value={chapters.length} />
      <h4 className="m-0 text-small font-medium text-muted">Edit the chapters</h4>
      {chapters.map((c, i) => (
        <fieldset key={i} className="m-0 flex min-w-0 flex-col gap-2 rounded-card bg-raised p-3 border-0">
          <legend className="px-0 text-small font-medium text-muted">Chapter {i + 1}</legend>
          <label className="flex flex-col gap-1 text-body">Title
            <input name={`title_${i}`} defaultValue={c.title} required maxLength={80} className={FIELD} />
          </label>
          <label className="flex flex-col gap-1 text-body">One line
            <input name={`line_${i}`} defaultValue={c.line} required maxLength={200} className={FIELD} />
          </label>
          <label className="flex flex-col gap-1 text-body">Seconds of narration
            <input name={`seconds_${i}`} type="number" inputMode="numeric" min={20} step={1} defaultValue={c.targetS} required className={FIELD} />
          </label>
        </fieldset>
      ))}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="secondary" loading={pending}>Save the edited outline</Button>
        <Result state={state} />
      </div>
    </form>
  );
}
