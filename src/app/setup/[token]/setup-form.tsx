"use client";

import { useActionState } from "react";
import { Button } from "@/ui/primitives/button";
import { Field } from "@/ui/auth/field";
import { setupAction, type SetupState } from "./actions";

export function SetupForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState<SetupState, FormData>(setupAction, {});
  if (state.invalid) return <p className="text-body text-pill-negative-ink">This link is invalid or has expired.</p>;
  return (
    <form action={action} className="flex w-full flex-col gap-5">
      <input type="hidden" name="token" value={token} />
      <Field label="Username" id="setup-username" name="username" autoComplete="username" required />
      <Field label="Password (12+ characters)" id="setup-password" name="password" type="password" autoComplete="new-password" required minLength={12} />
      <Field label="Repeat password" id="setup-confirm" name="confirm" type="password" autoComplete="new-password" required minLength={12} />
      {state.error ? (
        <p role="alert" className="text-body text-pill-negative-ink">
          {state.error}
        </p>
      ) : null}
      <Button type="submit" disabled={pending} className="w-full sm:min-h-11">
        Create owner account
      </Button>
    </form>
  );
}
