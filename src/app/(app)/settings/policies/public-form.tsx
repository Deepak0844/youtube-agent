"use client";

import { useActionState } from "react";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { Label } from "@/ui/primitives/label";
import { savePublicSwitchAction, type PublicState } from "./actions";

export function PublicSwitchForm({ allowed, phrase }: { allowed: boolean; phrase: string }) {
  const [state, action, pending] = useActionState<PublicState, FormData>(savePublicSwitchAction, {});
  return (
    <form action={action} className="flex flex-col gap-4" data-testid="public-form">
      <label className="flex min-h-11 items-center gap-3 text-body">
        <input type="checkbox" name="allowPublic" defaultChecked={allowed} className="size-5 accent-[var(--text)]" />
        Allow public publishing
      </label>
      <div className="flex min-w-0 flex-col gap-2">
        <Label htmlFor="typed-public">Type {phrase} to turn it on</Label>
        <Input id="typed-public" name="typed" autoComplete="off" spellCheck={false} />
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" disabled={pending}>Save</Button>
        {state.error ? <p role="alert" className="text-body text-pill-negative-ink">{state.error}</p> : state.ok ? <p role="status" className="text-small text-muted">Saved.</p> : null}
      </div>
    </form>
  );
}
