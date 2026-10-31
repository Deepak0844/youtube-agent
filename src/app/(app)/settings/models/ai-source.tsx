"use client";

import { useActionState } from "react";
import { Button } from "@/ui/primitives/button";
import { cn, focusRing } from "@/ui/lib/cn";
import { setAiSourceAction, testClaudeCodeAction, type FormState } from "./actions";

// The "AI source for text stages" switch and the Claude Code Test connection button (ADR 0014). Plain forms: they work
// before hydration. Only fixed sentences come back from the server.

const idle: FormState = {};

function Status({ state }: { state: FormState }) {
  return (
    <p role="status" aria-live="polite" className={cn("text-small", state.error ? "text-negative" : "text-positive")}>
      {state.error ?? state.note ?? (state.ok ? "Switched." : "")}
    </p>
  );
}

export function AiSourceForm({ on }: { on: boolean }) {
  const [state, action, pending] = useActionState(setAiSourceAction, idle);
  return (
    <form action={action} className="flex flex-col gap-3">
      <fieldset className="flex flex-col gap-1">
        <legend className="text-body font-medium">AI source for text stages</legend>
        {(
          [
            ["api", "API keys", !on],
            ["claude_code", "Claude Code (this machine)", on],
          ] as const
        ).map(([value, label, checked]) => (
          <label key={value} className="flex min-h-11 items-center gap-3 sm:min-h-9">
            <input type="radio" name="source" value={value} defaultChecked={checked} className={cn("size-5 shrink-0 accent-accent", focusRing)} />
            <span className="text-body">{label}</span>
          </label>
        ))}
      </fieldset>
      <label className="flex min-h-11 items-start gap-3 py-2 sm:min-h-9">
        <input type="checkbox" name="confirm" className={cn("mt-0.5 size-5 shrink-0 accent-accent", focusRing)} />
        <span className="text-body">
          I understand this starts a program (claude) on this Mac
          <span className="block text-small text-faint">Needed to switch to Claude Code. Switching back to API keys needs no tick.</span>
        </span>
      </label>
      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" disabled={pending}>
          {pending ? "Switching" : "Switch"}
        </Button>
        <Status state={state} />
      </div>
      {state.notes && state.notes.length > 0 ? (
        <ul className="flex flex-col gap-1 text-small text-warning">
          {state.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
    </form>
  );
}

export function TestClaudeCodeButton({ disabled }: { disabled: boolean }) {
  const [state, action, pending] = useActionState(testClaudeCodeAction, idle);
  return (
    <form action={action} className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
      <Button type="submit" variant="secondary" disabled={pending || disabled}>
        {pending ? "Testing" : "Test connection"}
      </Button>
      <span className="text-small text-faint">One tiny call. Counts toward the daily cap. At most once every 10 seconds.</span>
      <Status state={state} />
    </form>
  );
}
