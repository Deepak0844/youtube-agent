"use client";

import { useActionState, useState } from "react";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { Label } from "@/ui/primitives/label";
import { Pill } from "@/ui/primitives/pill";
import { saveGoogleAppAction, testGoogleAppAction } from "./actions";
import { IDLE_SAVE, IDLE_TEST, type SaveState, type TestState } from "./state";

export type VaultState = "ok" | "missing_key" | "wrong_key" | "unreadable";

const VAULT_TEXT: Record<Exclude<VaultState, "ok">, string> = {
  missing_key: "The vault key is not set, so the secret cannot be stored. Run npm run vault:init, restart the app, and come back.",
  wrong_key: "The vault key does not match the one that sealed the stored secrets. Restore the right VAULT_MASTER_KEY before saving anything.",
  unreadable: "Some vault entries cannot be read. Saving is switched off until npm run vault:check is clean.",
};

export function VaultBanner({ vault }: { vault: VaultState }) {
  if (vault === "ok") return null;
  return (
    <div role="alert" className="rounded-card bg-pill-negative-bg p-pad text-body text-pill-negative-ink">
      <p className="font-semibold">Saving is off</p>
      <p className="mt-1">{VAULT_TEXT[vault]}</p>
    </div>
  );
}

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      variant="secondary"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 2000);
        }, () => {});
      }}
    >
      {done ? "Copied" : "Copy"}
    </Button>
  );
}

function Field({ id, label, hint, error, children }: { id: string; label: string; hint?: string; error?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? (
        <p id={`${id}-err`} role="alert" className="text-small text-negative">
          {error}
        </p>
      ) : hint ? (
        <p className="text-small text-faint">{hint}</p>
      ) : null}
    </div>
  );
}

export function GoogleForm({ vault, maskedId, secretHint, secretStored }: { vault: VaultState; maskedId: string | null; secretHint: string; secretStored: boolean }) {
  const [state, action, pending] = useActionState<SaveState, FormData>(saveGoogleAppAction, IDLE_SAVE);
  const off = vault !== "ok";
  const e = state.fieldErrors ?? {};
  return (
    <form action={action} autoComplete="off" className="flex flex-col gap-5" aria-describedby="google-form-status">
      <Field
        id="clientId"
        label="Client ID"
        error={e.clientId}
        hint={maskedId ? `Stored: ${maskedId}. Leave empty to keep it.` : "From Google Cloud, Credentials. Ends in .apps.googleusercontent.com."}
      >
        <Input id="clientId" name="clientId" inputMode="text" spellCheck={false} autoCapitalize="none" disabled={off} aria-invalid={!!e.clientId} aria-describedby={e.clientId ? "clientId-err" : undefined} className="font-mono" />
      </Field>
      <Field
        id="clientSecret"
        label="Client secret"
        error={e.clientSecret}
        hint={secretStored ? "A secret is stored. Type a new one only to replace it." : "Goes straight into the encrypted vault. You will not be able to read it again."}
      >
        <Input id="clientSecret" name="clientSecret" type="password" spellCheck={false} autoCapitalize="none" autoComplete="new-password" disabled={off} aria-invalid={!!e.clientSecret} aria-describedby={e.clientSecret ? "clientSecret-err" : undefined} className="font-mono" />
        {secretStored ? (
          <p className="text-small text-muted">
            Stored secret: <span className="font-mono text-accent">{secretHint ? `••••${secretHint}` : "set (hidden)"}</span>
          </p>
        ) : null}
      </Field>
      <div id="google-form-status" aria-live="polite" className="min-h-5 text-body">
        {e.form ? <p className="text-negative">{e.form}</p> : null}
        {state.status === "error" && state.message ? <p className="text-negative">{state.message}</p> : null}
        {state.status === "saved" ? <p className="text-positive">{state.message}</p> : null}
      </div>
      <div>
        <Button type="submit" disabled={off || pending}>
          {pending ? "Saving…" : "Save to vault"}
        </Button>
      </div>
    </form>
  );
}

export function FormatTest({ disabled }: { disabled: boolean }) {
  const [state, action, pending] = useActionState<TestState, FormData>(testGoogleAppAction, IDLE_TEST);
  const r = state.result;
  const row = (label: string, ok: boolean) => (
    <li key={label} className="flex items-center justify-between gap-3 py-2">
      <span className="text-body">{label}</span>
      <Pill tone={ok ? "positive" : "negative"}>{ok ? "Looks right" : "Needs attention"}</Pill>
    </li>
  );
  return (
    <form action={action} className="flex flex-col gap-3">
      <p className="text-small text-faint">Checks the shape of what you saved. Nothing is sent to Google; a real sign-in test arrives with channel connection.</p>
      <div>
        <Button type="submit" variant="secondary" disabled={disabled || pending}>
          {pending ? "Checking…" : "Check format"}
        </Button>
      </div>
      <div aria-live="polite">
        {r ? (
          <ul data-testid="format-result" className="divide-y divide-rule">
            {row("Client ID shape", r.clientId)}
            {row("Client secret in vault", r.secret)}
            {row("Redirect address", r.redirectUri)}
          </ul>
        ) : null}
      </div>
    </form>
  );
}
