"use client";

import { useActionState } from "react";
import { setupAction, type SetupState } from "./actions";

export function SetupForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState<SetupState, FormData>(setupAction, {});
  if (state.invalid) return <p>This link is invalid or has expired.</p>;
  return (
    <form action={action} className="flex w-full max-w-sm flex-col gap-3">
      <input type="hidden" name="token" value={token} />
      <label className="flex flex-col gap-1 text-sm">
        Username
        <input name="username" autoComplete="username" required className="rounded border px-3 py-2" />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Password (12+ characters)
        <input name="password" type="password" autoComplete="new-password" required minLength={12} className="rounded border px-3 py-2" />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Repeat password
        <input name="confirm" type="password" autoComplete="new-password" required minLength={12} className="rounded border px-3 py-2" />
      </label>
      {state.error ? (
        <p role="alert" className="text-sm text-red-700">
          {state.error}
        </p>
      ) : null}
      <button type="submit" disabled={pending} className="rounded bg-black px-3 py-2 text-white disabled:opacity-60">
        Create owner account
      </button>
    </form>
  );
}
