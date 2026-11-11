"use client";

import { useActionState } from "react";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { Label } from "@/ui/primitives/label";
import { saveExtraDirAction, type ExtraDirState } from "./backup-actions";

/** The optional second place every backup is copied to. Empty and save = off. The folder is checked (exists, can be written to) before it is saved. */
export function ExtraDirForm({ current }: { current: string }) {
  const [state, run, pending] = useActionState<ExtraDirState, FormData>(saveExtraDirAction, {});
  return (
    <form action={run} data-testid="extra-dir-form" className="flex max-w-[60ch] flex-col gap-3">
      <div className="flex flex-col gap-1">
        <Label htmlFor="extra-dir">Extra backup folder</Label>
        <Input id="extra-dir" name="dir" defaultValue={current} placeholder="/Volumes/MyDrive/ytstudio-backups" autoComplete="off" spellCheck={false} maxLength={400} />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="secondary" disabled={pending}>Save</Button>
        {state.message ? <p role={state.ok ? "status" : "alert"} className={state.ok ? "m-0 text-body text-pill-positive-ink" : "m-0 text-body text-pill-negative-ink"}>{state.message}</p> : null}
      </div>
    </form>
  );
}
