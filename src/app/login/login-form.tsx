"use client";

import { useActionState, useState } from "react";
import { Button } from "@/ui/primitives/button";
import { Field } from "@/ui/auth/field";
import { loginAction, type LoginState } from "./actions";

// One form for both steps. When the password is right but a second factor is needed, the server answers needCode and the
// same form shows a code field; username and password stay in component state (controlled inputs) and are resubmitted.
export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(loginAction, {});
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  return (
    <form action={action} className="flex w-full flex-col gap-5">
      <input type="hidden" name="next" value={next} />
      <Field label="Username" id="login-username" name="username" autoComplete="username" required value={username} onChange={(e) => setUsername(e.target.value)} />
      <Field label="Password" id="login-password" name="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      {state.needCode ? (
        <Field label="Authentication or recovery code" id="login-code" name="code" autoComplete="one-time-code" required autoFocus />
      ) : null}
      {state.error ? (
        <p role="alert" className="text-body text-pill-negative-ink">
          {state.error}
        </p>
      ) : null}
      <Button type="submit" disabled={pending} className="w-full sm:min-h-11">
        Sign in
      </Button>
    </form>
  );
}
