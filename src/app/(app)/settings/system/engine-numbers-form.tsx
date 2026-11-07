"use client";

import { useActionState, useState } from "react";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { Label } from "@/ui/primitives/label";
import { saveEngineNumbersAction } from "./actions";
import type { FormState } from "./actions";

export interface EngineNumberRow {
  key: string;
  label: string;
  note: string;
  unit: string;
  min: number;
  max: number;
  kind: "number" | "list";
  /** Text of the registry default and of the saved value. */
  def: string;
  current: string;
}

export function EngineNumbersForm({ rows }: { rows: EngineNumberRow[] }) {
  const [state, action, pending] = useActionState<FormState, FormData>(saveEngineNumbersAction, {});
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(rows.map((r) => [r.key, r.current])));
  return (
    <form action={action} className="flex flex-col gap-5">
      <div className="grid gap-4 sm:grid-cols-2">
        {rows.map((r) => {
          const id = `en-${r.key.replace(/\W/g, "-")}`;
          const changed = values[r.key] !== r.def;
          return (
            <div key={r.key} className="flex min-w-0 flex-col gap-2">
              <Label htmlFor={id}>{r.label} ({r.unit})</Label>
              <div className="flex gap-2">
                <Input
                  id={id}
                  name={r.key}
                  type="text"
                  inputMode="decimal"
                  required
                  aria-describedby={`${id}-help`}
                  value={values[r.key]}
                  onChange={(e) => setValues((v) => ({ ...v, [r.key]: e.target.value }))}
                />
                <Button type="button" variant="ghost" disabled={!changed} aria-label={`Reset ${r.label} to default`} onClick={() => setValues((v) => ({ ...v, [r.key]: r.def }))}>
                  Reset
                </Button>
              </div>
              <p id={`${id}-help`} className="text-small text-faint">
                {r.note} Default {r.def}. Allowed {r.min} to {r.max}.
              </p>
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" disabled={pending}>Save engine numbers</Button>
        {state.error ? (
          <p role="alert" className="text-body text-pill-negative-ink">{state.error}</p>
        ) : state.ok ? (
          <p role="status" className="text-body text-pill-positive-ink">Saved.</p>
        ) : (
          <p role="status" className="sr-only" />
        )}
      </div>
    </form>
  );
}
