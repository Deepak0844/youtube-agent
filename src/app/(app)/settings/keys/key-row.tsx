"use client";

import { useActionState, useId, useState } from "react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogTitle, AlertDialogTrigger } from "@/ui/primitives/alert-dialog";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { Label } from "@/ui/primitives/label";
import { Pill } from "@/ui/primitives/pill";
import { removeKeyAction, setKeyAction, testKeyAction, type KeyActionState } from "./actions";

export interface KeyRowProps {
  id: string;
  label: string;
  note: string;
  shapeHint: string;
  isSet: boolean;
  tail: string;
  savedLabel: string;
  lastTest: { result: "ok" | "rejected" | "unreachable"; label: string } | null;
  canSave: boolean;
}

const TEST_PILL = {
  ok: { tone: "positive", text: "Works" },
  rejected: { tone: "negative", text: "Rejected by provider" },
  unreachable: { tone: "warning", text: "Could not reach" },
} as const;

const noState: KeyActionState = {};

/** One provider on the rack: what is stored (masked), the last test, and the three things you can do. */
export function KeyRow(p: KeyRowProps) {
  const uid = useId();
  const [editing, setEditing] = useState(false);
  const [setState, setAction, setPending] = useActionState(async (prev: KeyActionState, form: FormData) => {
    const r = await setKeyAction(prev, form);
    if (r.kind === "saved") setEditing(false); // close the editor once the key is stored
    return r;
  }, noState);
  const [testState, testAction, testPending] = useActionState(testKeyAction, noState);
  const [removeState, removeAction, removePending] = useActionState(removeKeyAction, noState);

  const showInput = !p.isSet || editing;
  const message = [setState, removeState, testState].filter((s) => s.n).sort((a, b) => (b.n ?? 0) - (a.n ?? 0))[0];
  const error = message?.kind === "error" ? message.message : undefined;
  const testPill = testState.kind === "tested" && testState.result ? TEST_PILL[testState.result] : p.lastTest ? TEST_PILL[p.lastTest.result] : null;
  const inputId = `${uid}-value`;
  const hintId = `${uid}-hint`;
  const busy = setPending || testPending || removePending;

  return (
    <li className="rounded-card bg-surface p-pad" data-provider={p.id}>
      <div className="grid min-w-0 gap-gap md:grid-cols-[minmax(0,1fr)_auto] md:items-start md:gap-x-8">
        <div className="min-w-0">
          <h3 className="text-section font-semibold">{p.label}</h3>
          <p className="mt-1 text-small text-muted">{p.note}</p>
          <p className="mt-3 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 text-small text-muted">
            {p.isSet ? (
              <>
                <Pill tone="neutral">Saved</Pill>
                <span className="font-mono text-body text-text tabular-nums" aria-label={p.tail ? `ends in ${p.tail}` : "value hidden"}>
                  {p.tail ? `•••• ${p.tail}` : "••••••••"}
                </span>
                <span>{p.savedLabel}</span>
              </>
            ) : (
              <Pill tone="neutral">Not set</Pill>
            )}
          </p>
          {p.isSet ? (
            <p className="mt-2 flex flex-wrap items-center gap-2 text-small text-muted" data-testid={`test-status-${p.id}`}>
              {testPill ? (
                <>
                  <Pill tone={testPill.tone}>{testPill.text}</Pill>
                  <span>{testState.kind === "tested" ? "Just now" : p.lastTest?.label}</span>
                </>
              ) : (
                <span>Not tested yet</span>
              )}
            </p>
          ) : null}
        </div>

        {p.isSet ? (
          <div className="flex flex-wrap items-center gap-2 md:justify-end">
            <form action={testAction}>
              <input type="hidden" name="provider" value={p.id} />
              <Button type="submit" variant="secondary" disabled={busy || !p.canSave} aria-label={`Test ${p.label} key`}>
                {testPending ? "Testing…" : "Test"}
              </Button>
            </form>
            <Button variant="secondary" disabled={!p.canSave || busy} aria-expanded={showInput} onClick={() => setEditing((v) => !v)} aria-label={`Replace ${p.label} key`}>
              {editing ? "Cancel" : "Replace"}
            </Button>
            <form id={`${uid}-remove`} action={removeAction}>
              <input type="hidden" name="provider" value={p.id} />
            </form>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="destructive" disabled={busy} aria-label={`Remove ${p.label} key`}>
                  Remove
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogTitle>Remove the {p.label} key?</AlertDialogTitle>
                <AlertDialogDescription>
                  The stored key is deleted from the vault. Anything that needs {p.label} stops working until you add a key again. This cannot be undone.
                </AlertDialogDescription>
                <div className="flex flex-wrap justify-end gap-2">
                  <AlertDialogCancel>Keep key</AlertDialogCancel>
                  <AlertDialogAction type="submit" form={`${uid}-remove`}>
                    Remove key
                  </AlertDialogAction>
                </div>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        ) : null}
      </div>

      {showInput ? (
        <form action={setAction} className="mt-gap flex min-w-0 flex-col gap-2 md:max-w-xl" autoComplete="off">
          <input type="hidden" name="provider" value={p.id} />
          <Label htmlFor={inputId}>{p.isSet ? `New ${p.label} key` : `${p.label} API key`}</Label>
          <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
            <Input
              id={inputId}
              name="value"
              type="password"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              required
              maxLength={400}
              disabled={!p.canSave}
              aria-describedby={hintId}
              aria-invalid={setState.kind === "error" ? true : undefined}
              data-1p-ignore
              data-lpignore="true"
              className="min-w-0 font-mono"
            />
            <Button type="submit" disabled={!p.canSave || setPending} className="shrink-0">
              {setPending ? "Saving…" : p.isSet ? "Replace key" : "Save key"}
            </Button>
          </div>
          <p id={hintId} className="text-small text-faint">
            {p.canSave ? `Looks like: ${p.shapeHint}. Stored encrypted; it is never shown again.` : "Saving is off until the vault problem above is fixed."}
          </p>
        </form>
      ) : null}

      <p role="status" aria-live="polite" className={`mt-2 min-h-5 text-small ${error ? "text-pill-negative-ink" : "text-muted"}`}>
        {error ?? (message?.kind === "saved" || message?.kind === "removed" ? message.message : "")}
      </p>
    </li>
  );
}
