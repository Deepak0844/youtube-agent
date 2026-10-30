"use client";

import { useActionState, useState } from "react";
import { Button, type ButtonProps } from "@/ui/primitives/button";
import { Label } from "@/ui/primitives/label";
import { approveGateAction, cancelVideoAction, requeueUploadAction, resetBreakerAction, resolveDecisionAction, sendBackAction, startDryRunAction, type QueueState } from "./actions";

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
      <Button type="submit" variant={variant} disabled={pending} aria-label={ariaLabel}>
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
        <Button type="submit" variant={variant} disabled={pending}>
          {label}
        </Button>
        <Result state={state} />
      </div>
    </form>
  );
}
