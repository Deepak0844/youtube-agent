"use client";

import { useActionState, useState } from "react";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { Label } from "@/ui/primitives/label";
import { addVoiceServiceAction, type FormState } from "../system/actions";
import { saveVoiceServerAction, type VoiceFormState } from "./voice-actions";

export interface VoiceServerView {
  field: "voicestudio_url" | "local_url" | "azure_region";
  label: string;
  help: string;
  placeholder: string;
  value: string;
  /** host:port to offer adding to the local-services list, or null when nothing is needed. */
  missing: string | null;
}

function AddToList({ field, entry }: { field: string; entry: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(addVoiceServiceAction, {});
  return (
    <form action={action} className="flex flex-col gap-2 rounded-card bg-pill-warning-bg p-4 text-pill-warning-ink">
      <p role="note" className="text-body">
        Add {entry} under System &gt; Local services, otherwise calls are refused.
      </p>
      <input type="hidden" name="field" value={field} />
      <label className="flex min-h-11 items-center gap-3 text-body">
        <input type="checkbox" name="confirm" required className="size-5 accent-[var(--text)]" />
        I understand the app will be allowed to call this address
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending}>Add {entry}</Button>
        {state.error ? <p role="alert" className="text-body text-pill-negative-ink">{state.error}</p> : null}
        {state.ok ? <p role="status" className="text-body text-pill-positive-ink">Added.</p> : null}
      </div>
    </form>
  );
}

function Field({ v }: { v: VoiceServerView }) {
  const [state, action, pending] = useActionState<VoiceFormState, FormData>(saveVoiceServerAction, {});
  const [val, setVal] = useState(v.value); // controlled: React 19 resets uncontrolled fields after an action, which would wipe a refused value
  const id = `voice-${v.field}`;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <form action={action} className="flex min-w-0 flex-col gap-2">
        <Label htmlFor={id}>{v.label}</Label>
        <input type="hidden" name="field" value={v.field} />
        <div className="flex flex-wrap items-center gap-3">
          <Input id={id} name="value" value={val} onChange={(e) => setVal(e.target.value)} placeholder={v.placeholder} maxLength={300} autoComplete="off" spellCheck={false} aria-describedby={`${id}-help`} aria-invalid={state.error ? true : undefined} className="max-w-md flex-1" />
          <Button type="submit" disabled={pending}>Save</Button>
        </div>
        <p id={`${id}-help`} className="max-w-[60ch] text-small text-faint">{v.help}</p>
        <p className="text-small text-muted">Now: {v.value ? <code className="font-mono">{v.value}</code> : "not set"}</p>
        {state.error ? <p role="alert" className="text-body text-pill-negative-ink">{state.error}</p> : null}
        {state.ok ? <p role="status" className="text-body text-pill-positive-ink">Saved.</p> : null}
      </form>
      {v.missing ? <AddToList field={v.field} entry={v.missing} /> : null}
    </div>
  );
}

export function VoiceServers({ items }: { items: VoiceServerView[] }) {
  return (
    <div className="flex flex-col gap-6">
      {items.map((v) => (
        <Field key={v.field} v={v} />
      ))}
    </div>
  );
}
