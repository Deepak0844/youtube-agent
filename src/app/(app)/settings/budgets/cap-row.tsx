"use client";

import { useActionState, useId, useRef, useState } from "react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from "@/ui/primitives/alert-dialog";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { Label } from "@/ui/primitives/label";
import { Pill } from "@/ui/primitives/pill";
import { Switch } from "@/ui/primitives/switch";
import { saveCapAction, type CapActionState } from "./actions";

export interface CapRowProps {
  scope: string;
  title: string;
  note: string;
  /** "$2.00", or null for no limit. */
  capLabel: string | null;
  /** The figure to start the editor with ("2.00"), empty for no limit. */
  capInput: string;
  /** "this kind of video", "a day" ...: finishes "Nothing will stop spending on ...". */
  what: string;
}

const none: CapActionState = {};

/** One cap on the Budgets page: what it is now, and an editor with a "No limit" switch that asks before it saves. */
export function CapRow(p: CapRowProps) {
  const uid = useId();
  const [editing, setEditing] = useState(false);
  const [unlimited, setUnlimited] = useState(p.capLabel === null);
  const [confirming, setConfirming] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const [state, action, pending] = useActionState(async (prev: CapActionState, data: FormData) => {
    const r = await saveCapAction(prev, data);
    if (r.kind === "saved") setEditing(false);
    return r;
  }, none);
  const inputId = `${uid}-dollars`;
  const switchId = `${uid}-unlimited`;
  const message = state.kind ? state.message : undefined;

  return (
    <li className="rounded-card bg-surface p-pad" data-scope={p.scope}>
      <div className="grid min-w-0 gap-gap md:grid-cols-[minmax(0,1fr)_auto] md:items-center md:gap-x-8">
        <div className="min-w-0">
          <h3 className="text-section font-semibold">{p.title}</h3>
          <p className="mt-1 text-small text-muted">{p.note}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3 md:justify-end">
          <span className="text-section font-semibold tabular-nums" data-testid={`cap-${p.scope}`}>
            {p.capLabel ?? "no limit"}
          </span>
          {p.capLabel === null ? <Pill tone="warning">Unlimited</Pill> : null}
          <Button variant="secondary" aria-expanded={editing} aria-label={`Edit ${p.title} limit`} onClick={() => setEditing((v) => !v)}>
            {editing ? "Cancel" : "Edit"}
          </Button>
        </div>
      </div>

      {editing ? (
        <form
          ref={form}
          action={action}
          className="mt-gap flex min-w-0 flex-col gap-3 md:max-w-xl"
          onSubmit={(e) => {
            // Switching spending limits off needs a second, plain-words yes. The confirm button submits the form again.
            if (unlimited && !confirming) {
              e.preventDefault();
              setConfirming(true);
            }
          }}
        >
          <input type="hidden" name="scope" value={p.scope} />
          {unlimited ? <input type="hidden" name="unlimited" value="on" /> : null}
          <div className="flex min-w-0 flex-col gap-2">
            <Label htmlFor={inputId}>Limit in dollars</Label>
            <Input id={inputId} name="dollars" inputMode="decimal" autoComplete="off" maxLength={20} defaultValue={p.capInput} disabled={unlimited} required={!unlimited} className="tabular-nums sm:max-w-48" />
          </div>
          <div className="flex min-h-11 items-center gap-3">
            <Switch id={switchId} checked={unlimited} onCheckedChange={setUnlimited} aria-label={`No limit for ${p.title}`} />
            <Label htmlFor={switchId}>No limit</Label>
          </div>
          <div>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save limit"}
            </Button>
          </div>
        </form>
      ) : null}

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogTitle>Remove the limit for {p.title.toLowerCase()}?</AlertDialogTitle>
          <AlertDialogDescription>
            Nothing will stop spending on {p.what}. Every paid step will go ahead, however much it costs. You can set a limit again at any time.
          </AlertDialogDescription>
          <div className="flex flex-wrap justify-end gap-2">
            <AlertDialogCancel>Keep a limit</AlertDialogCancel>
            <AlertDialogAction onClick={() => form.current?.requestSubmit()}>Remove limit</AlertDialogAction>
          </div>
        </AlertDialogContent>
      </AlertDialog>

      <p role="status" aria-live="polite" className={`mt-2 min-h-5 text-small ${state.kind === "error" ? "text-pill-negative-ink" : "text-muted"}`}>
        {message ?? ""}
      </p>
    </li>
  );
}
