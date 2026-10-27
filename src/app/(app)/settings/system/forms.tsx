"use client";

import { useActionState, useState } from "react";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { Label } from "@/ui/primitives/label";
import { saveLimitsAction, saveLocalServicesAction, type FormState } from "./actions";

const field = "flex min-w-0 flex-col gap-2";

function Result({ state }: { state: FormState }) {
  if (state.error) {
    return (
      <div role="alert" className="text-body text-pill-negative-ink">
        <p>{state.error}</p>
        {state.lines?.length ? (
          <ul className="mt-1 list-disc pl-5 text-small">
            {state.lines.map((l) => (
              <li key={`${l.line}-${l.reason}`}>{l.line > 0 ? `Line ${l.line}: ` : ""}{l.reason}</li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  }
  return state.ok ? <p role="status" className="text-body text-pill-positive-ink">Saved.</p> : <p role="status" className="sr-only" />;
}

export function LimitsForm(props: { renders: number; jobs: number; warnGb: number; longMinutes: number; sceneKit: boolean; tracksLater: string[] }) {
  const [state, action, pending] = useActionState<FormState, FormData>(saveLimitsAction, {});
  return (
    <form action={action} className="flex flex-col gap-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className={field}>
          <Label htmlFor="concurrent_renders">Videos rendering at once</Label>
          <Input id="concurrent_renders" name="concurrent_renders" type="number" inputMode="numeric" min={1} max={8} step={1} required defaultValue={props.renders} />
        </div>
        <div className={field}>
          <Label htmlFor="concurrent_jobs">Jobs running at once</Label>
          <Input id="concurrent_jobs" name="concurrent_jobs" type="number" inputMode="numeric" min={1} max={16} step={1} required defaultValue={props.jobs} />
        </div>
        <div className={field}>
          <Label htmlFor="storage_warn_gb">Storage warning (GB)</Label>
          <Input id="storage_warn_gb" name="storage_warn_gb" type="number" inputMode="numeric" min={1} step={1} required defaultValue={props.warnGb} />
        </div>
        <div className={field}>
          <Label htmlFor="max_long_minutes">Longest long video (minutes)</Label>
          <Input id="max_long_minutes" name="max_long_minutes" type="number" inputMode="numeric" min={1} max={240} step={1} required defaultValue={props.longMinutes} />
        </div>
      </div>
      <fieldset className="flex flex-col gap-3">
        <legend className="text-small font-medium text-muted">Ways to make a video</legend>
        <label className="flex min-h-11 items-center gap-3 text-body">
          <input type="checkbox" name="scene_kit" defaultChecked={props.sceneKit} className="size-5 accent-[var(--text)]" />
          Scene kit
        </label>
        {props.tracksLater.map((t) => (
          <p key={t} className="flex min-h-11 items-center gap-3 text-body text-faint">
            <input type="checkbox" disabled checked={false} readOnly aria-label={t} className="size-5" />
            {t} <span className="text-small">arrives in a later phase</span>
          </p>
        ))}
      </fieldset>
      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" disabled={pending}>Save limits</Button>
        <Result state={state} />
      </div>
    </form>
  );
}

export function LocalServicesForm({ entries, max }: { entries: string[]; max: number }) {
  const [state, action, pending] = useActionState<FormState, FormData>(saveLocalServicesAction, {});
  // Controlled on purpose: React resets uncontrolled fields after every form action, which would wipe what was typed
  // when the server refuses it (the messages name its line numbers). The saved list from the server replaces the text
  // whenever it changes (after a successful save it comes back normalised).
  const saved = entries.join("\n");
  const [text, setText] = useState(saved);
  const [seen, setSeen] = useState(saved);
  if (seen !== saved) {
    setSeen(saved);
    setText(saved);
  }
  return (
    <form action={action} className="flex flex-col gap-4">
      <div className={field}>
        <Label htmlFor="services">Allowed local services, one per line</Label>
        <textarea
          id="services"
          name="services"
          rows={Math.max(4, Math.min(entries.length + 2, 10))}
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-describedby="services-help"
          className="min-h-28 w-full rounded-card border border-control bg-surface px-4 py-3 font-mono text-body text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-text"
        />
        <p id="services-help" className="text-small text-faint">
          Exact host and port, for example localhost:11434 or 192.168.1.20:1234. No wildcards or ranges, at most {max}.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" disabled={pending}>Save list</Button>
        <Result state={state} />
      </div>
    </form>
  );
}
