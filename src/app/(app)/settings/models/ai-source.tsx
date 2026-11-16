"use client";

import { useActionState } from "react";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { cn, focusRing } from "@/ui/lib/cn";
import { cancelClaudeLoginAction, setAiSourceAction, startClaudeLoginAction, submitClaudeLoginCodeAction, testClaudeCodeAction, type FormState } from "./actions";

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
        <Button type="submit" loading={pending}>
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

// Connect Claude: log in to Claude Code without a terminal. The server holds the login; `waitingUrl` is its link (null = none waiting).
// Plain forms. The pasted code is only ever sent to the server action; autocomplete is off so the browser keeps no copy.
export function ConnectClaudeForm({ waitingUrl }: { waitingUrl: string | null }) {
  const [started, startAction, starting] = useActionState(startClaudeLoginAction, idle);
  const [sent, sendAction, sending] = useActionState(submitClaudeLoginCodeAction, idle);
  const [cancelled, cancelAction, cancelling] = useActionState(cancelClaudeLoginAction, idle);
  if (!waitingUrl) {
    return (
      <form action={startAction} className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
        <Button type="submit" variant="secondary" disabled={starting}>
          {starting ? "Starting" : "Connect Claude"}
        </Button>
        <span className="text-small text-faint">Signs this app in to Claude Code with your claude.ai subscription. No terminal needed.</span>
        <Status state={sent.ok !== undefined || sent.error ? sent : started.error ? started : cancelled} />
      </form>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <ol className="flex list-decimal flex-col gap-1 pl-5 text-body">
        <li>
          <a href={waitingUrl} target="_blank" rel="noopener noreferrer" className={cn("text-accent underline", focusRing)}>Open the sign-in page</a> and sign in with your claude.ai subscription.
        </li>
        <li>Copy the code it shows and paste it here.</li>
      </ol>
      <form action={sendAction} className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
        <label className="sr-only" htmlFor="claude-code-paste">Code from the sign-in page</label>
        <Input id="claude-code-paste" name="code" required autoComplete="off" spellCheck={false} placeholder="Paste the code" className="min-h-11 sm:min-h-9 sm:max-w-md" />
        <Button type="submit" disabled={sending}>{sending ? "Checking" : "Connect"}</Button>
        <Button type="submit" variant="ghost" formAction={cancelAction} formNoValidate disabled={sending || cancelling}>Cancel</Button>
      </form>
      <Status state={sent} />
    </div>
  );
}
