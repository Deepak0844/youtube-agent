"use client";

import Link from "next/link";
import { useActionState, useRef } from "react";
import { Pill } from "@/ui/primitives/pill";
import { Switch } from "@/ui/primitives/switch";
import { toggleProviderAction } from "./actions";

export interface ProviderView {
  id: string;
  label: string;
  enabled: boolean;
  keyStatus: "saved" | "not needed" | "missing";
  languages: string;
  timing: string | null;
  price: string;
  commercial: string;
}

/** One provider: the switch posts the opposite of its current state; the server decides (key rule) and the page refreshes. */
function ProviderRow({ p }: { p: ProviderView }) {
  const [state, action, pending] = useActionState(toggleProviderAction, {});
  const form = useRef<HTMLFormElement>(null);
  return (
    <li className="rounded-card bg-surface p-pad" data-provider={p.id}>
      <div className="grid min-w-0 gap-gap md:grid-cols-[minmax(0,1fr)_auto] md:items-start md:gap-x-8">
        <div className="min-w-0">
          <h3 className="text-section font-semibold">{p.label}</h3>
          <p className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 text-small text-muted">
            {p.keyStatus === "missing" ? (
              <Link href="/settings/keys" className="underline">
                <Pill tone="warning">Key needed</Pill>
              </Link>
            ) : (
              <Pill tone="neutral">{p.keyStatus === "saved" ? "Key saved" : "No key needed"}</Pill>
            )}
            {p.timing ? <Pill tone="neutral">Word timing: {p.timing}</Pill> : null}
            <span data-testid={`price-${p.id}`}>{p.price}</span>
          </p>
          <p className="mt-2 text-small text-muted">
            {p.languages ? `Languages: ${p.languages}. ` : ""}
            {p.commercial}
          </p>
        </div>
        <form ref={form} action={action} className="flex min-h-11 items-center gap-3">
          <input type="hidden" name="provider" value={p.id} />
          <input type="hidden" name="enabled" value={String(!p.enabled)} />
          <Switch checked={p.enabled} disabled={pending} onCheckedChange={() => form.current?.requestSubmit()} aria-label={`${p.label} on`} />
          <span className="text-small text-muted">{p.enabled ? "On" : "Off"}</span>
        </form>
      </div>
      <p role="status" aria-live="polite" className="mt-2 min-h-5 text-small text-pill-negative-ink">
        {state.error ?? ""}
      </p>
    </li>
  );
}

export function ProviderList({ providers }: { providers: ProviderView[] }) {
  return (
    <ul className="m-0 flex list-none flex-col gap-gap p-0">
      {providers.map((p) => (
        <ProviderRow key={p.id} p={p} />
      ))}
    </ul>
  );
}
