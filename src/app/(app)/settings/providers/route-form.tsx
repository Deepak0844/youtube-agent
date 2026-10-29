"use client";

import { useActionState } from "react";
import { cn, control, focusRing } from "@/ui/lib/cn";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { Label } from "@/ui/primitives/label";
import { setRouteAction } from "./actions";

const selectClass = cn("w-full rounded-control border border-control bg-surface px-4 text-body text-text", control, focusRing);

/** Pick a provider that is switched on and priced, where it applies, and (for voices) the default narration voice. */
export function RouteForm({ providers, scopes }: { providers: { id: string; label: string }[]; scopes: { id: string; label: string }[] }) {
  const [state, action, pending] = useActionState(setRouteAction, {});
  return (
    <form action={action} className="grid min-w-0 gap-3 md:max-w-3xl md:grid-cols-3">
      <div className="flex min-w-0 flex-col gap-2">
        <Label htmlFor="route-provider">Provider</Label>
        <select id="route-provider" name="provider" required className={selectClass}>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <Label htmlFor="route-scope">Used for</Label>
        <select id="route-scope" name="scope" required className={selectClass}>
          {scopes.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <Label htmlFor="route-voice">Narration voice (voice providers only)</Label>
        <Input id="route-voice" name="voice" maxLength={100} autoComplete="off" />
      </div>
      <div className="flex flex-wrap items-center gap-3 md:col-span-3">
        <Button type="submit" disabled={pending || providers.length === 0}>
          {pending ? "Saving…" : "Use for this"}
        </Button>
        <p role="status" aria-live="polite" className={cn("text-small", state.error ? "text-pill-negative-ink" : "text-muted")}>
          {state.error ?? (state.ok ? "Saved." : providers.length === 0 ? "Switch on a priced provider first." : "")}
        </p>
      </div>
    </form>
  );
}
