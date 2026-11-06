"use client";

import { useActionState } from "react";
import { DEFAULT_DAILY_CAP, MAX_DAILY_CAP, SCOPE_LABEL, TOKEN_SCOPES } from "@/server/core/api-token";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { Label } from "@/ui/primitives/label";
import { createTokenAction } from "./actions";
import { IDLE_CREATE, type CreateState } from "./state";

export function TokenForm() {
  const [state, action, pending] = useActionState<CreateState, FormData>(createTokenAction, IDLE_CREATE);
  return (
    <div className="flex flex-col gap-5">
      {state.status === "created" ? (
        <div role="status" className="rounded-card bg-pill-positive-bg p-pad text-body text-pill-positive-ink">
          <p className="font-semibold">Token &quot;{state.name}&quot; created. Copy it now: it is shown only once.</p>
          <p data-testid="new-token" className="mt-2 break-all font-mono select-all">
            {state.secret}
          </p>
        </div>
      ) : null}
      <form action={action} autoComplete="off" className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <Label htmlFor="name">Name</Label>
          <Input id="name" name="name" maxLength={60} required placeholder="Phone shortcut" />
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="text-body font-medium">Permissions</legend>
          {TOKEN_SCOPES.map((s) => (
            <label key={s} className="flex items-center gap-2 text-body">
              <input type="checkbox" name="scopes" value={s} defaultChecked />
              {SCOPE_LABEL[s]}
            </label>
          ))}
          <p className="text-small text-faint">A token can never approve a step, change a safety setting, or open settings, keys or tokens.</p>
        </fieldset>
        <div className="flex flex-col gap-2">
          <Label htmlFor="cap">Drafts it may create per day (India time)</Label>
          <Input id="cap" name="cap" type="number" min={0} max={MAX_DAILY_CAP} defaultValue={DEFAULT_DAILY_CAP} inputMode="numeric" />
        </div>
        <div aria-live="polite" className="min-h-5 text-body">
          {state.status === "error" ? <p className="text-negative">{state.message}</p> : null}
        </div>
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? "Creating…" : "Create token"}
          </Button>
        </div>
      </form>
    </div>
  );
}
