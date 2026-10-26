"use client";

import { useActionState, useState } from "react";
import { loginAction, type LoginState } from "./actions";

// One form for both steps. When the password is right but a second factor is needed, the server answers needCode and the
// same form shows a code field; username and password stay in component state (controlled inputs) and are resubmitted.
export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(loginAction, {});
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  return (
    <form action={action} className="flex w-full max-w-sm flex-col gap-3">
      <input type="hidden" name="next" value={next} />
      <label className="flex flex-col gap-1 text-sm">
        Username
        <input name="username" autoComplete="username" required value={username} onChange={(e) => setUsername(e.target.value)} className="rounded border px-3 py-2" />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Password
        <input name="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} className="rounded border px-3 py-2" />
      </label>
      {state.needCode ? (
        <label className="flex flex-col gap-1 text-sm">
          Authentication or recovery code
          <input name="code" autoComplete="one-time-code" required autoFocus className="rounded border px-3 py-2" />
        </label>
      ) : null}
      {state.error ? (
        <p role="alert" className="text-sm text-negative">
          {state.error}
        </p>
      ) : null}
      <button type="submit" disabled={pending} className="rounded-control bg-text px-4 py-2 font-medium text-ground disabled:opacity-60">
        Sign in
      </button>
    </form>
  );
}
