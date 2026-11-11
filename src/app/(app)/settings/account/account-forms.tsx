"use client";

import { useActionState } from "react";
import { MIN_PASSWORD_LENGTH } from "@/server/core/auth-rules";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { Label } from "@/ui/primitives/label";
import { changePasswordAction, signOutOthersAction, signOutSessionAction, type AccountState } from "./actions";

const Msg = ({ s }: { s: AccountState }) =>
  s.message ? <p role={s.ok ? "status" : "alert"} className={s.ok ? "m-0 text-body text-pill-positive-ink" : "m-0 text-body text-pill-negative-ink"}>{s.message}</p> : null;

/** Change the password: the current one, the new one twice. Nothing typed is shown again, and the fields clear after a success. */
export function PasswordForm() {
  const [state, run, pending] = useActionState<AccountState, FormData>(changePasswordAction, {});
  return (
    <form action={run} key={state.ok ? "done" : "open"} data-testid="password-form" className="flex max-w-[44ch] flex-col gap-4">
      <div className="flex flex-col gap-1">
        <Label htmlFor="current">Current password</Label>
        <Input id="current" name="current" type="password" autoComplete="current-password" required maxLength={1024} />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="next">New password</Label>
        <Input id="next" name="next" type="password" autoComplete="new-password" required maxLength={1024} aria-describedby="next-help" />
        <p id="next-help" className="m-0 text-small text-muted">At least {MIN_PASSWORD_LENGTH} characters. A short sentence works well.</p>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="again">New password again</Label>
        <Input id="again" name="again" type="password" autoComplete="new-password" required maxLength={1024} />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" loading={pending}>Change password</Button>
        <Msg s={state} />
      </div>
    </form>
  );
}

/** Sign out every sign-in except this one. */
export function SignOutOthersForm({ others }: { others: number }) {
  const [state, run, pending] = useActionState<AccountState, FormData>(signOutOthersAction as (s: AccountState, f: FormData) => Promise<AccountState>, {});
  return (
    <form action={run} data-testid="signout-others" className="flex flex-wrap items-center gap-3">
      <Button type="submit" variant="secondary" disabled={pending || others === 0}>Sign out all other sign-ins</Button>
      <Msg s={state} />
    </form>
  );
}

/** Sign out one other sign-in. */
export function SignOutOneForm({ id, label }: { id: string; label: string }) {
  const [state, run, pending] = useActionState<AccountState, FormData>(signOutSessionAction, {});
  return (
    <form action={run} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="id" value={id} />
      <Button type="submit" variant="secondary" loading={pending} aria-label={`Sign out ${label}`}>Sign out</Button>
      <Msg s={state} />
    </form>
  );
}
