"use client";

import { useActionState } from "react";
import { cn, control, fade, focusRing } from "@/ui/lib/cn";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { Label } from "@/ui/primitives/label";
import { requestCutoutAction, type CutoutState } from "./cutout-actions";

const selectClass = cn("w-full rounded-control border border-control bg-surface px-4 text-body text-text", control, fade, focusRing);

const NUM = [
  ["erode", "Edge trim (px)", 1, 0, 4, "Eats this much off the edge to remove a halo of old background."],
  ["feather", "Soft edge (px)", 1, 0, 8, "A little blur on the edge so it does not look cut with scissors."],
  ["pad", "Margin (px)", 8, 0, 64, "Empty space kept around the object."],
  ["sticker", "White sticker border (px)", 0, 0, 24, "0 = none. A white outline around the object, like a sticker."],
  ["tolerance", "White tolerance", 24, 0, 80, "White method only: how far from pure white still counts as background."],
] as const;

export function CutoutForm({ id }: { id: string }) {
  const [state, run, pending] = useActionState<CutoutState, FormData>(requestCutoutAction, {});
  return (
    <form action={run} className="flex max-w-xl min-w-0 flex-col gap-4" data-testid="cutout-form">
      <input type="hidden" name="id" value={id} />
      <div className="flex flex-col gap-2">
        <Label htmlFor="cutout-method">How</Label>
        <select id="cutout-method" name="method" defaultValue="model" className={selectClass}>
          <option value="model">With the background remover (any photo)</option>
          <option value="white">Remove a plain white background (art on white)</option>
        </select>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {NUM.map(([name, label, def, min, max, help]) => (
          <div key={name} className="flex min-w-0 flex-col gap-1">
            <Label htmlFor={`cutout-${name}`}>{label}</Label>
            <Input id={`cutout-${name}`} name={name} type="number" inputMode="numeric" min={min} max={max} step={1} defaultValue={def} aria-describedby={`cutout-${name}-h`} />
            <p id={`cutout-${name}-h`} className="m-0 text-small text-faint">{help}</p>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending}>{pending ? "Asking..." : "Make a cut-out"}</Button>
        <p role="status" aria-live="polite" className={cn("m-0 text-body", state.message ? "text-pill-negative-ink" : "text-muted")}>
          {state.message ?? (state.ok ? "Asked for. It is made in the background; this list updates." : "")}
        </p>
      </div>
    </form>
  );
}
