"use client";

import { useActionState } from "react";
import { Button } from "@/ui/primitives/button";
import { retentionAction, type RetentionState } from "./retention-actions";

const mb = (b: number) => (b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);

export function RetentionPanel() {
  const [state, run, pending] = useActionState<RetentionState, FormData>(retentionAction, {});
  const p = state.plan;
  return (
    <div data-testid="retention-panel" className="flex min-w-0 flex-col gap-3">
      <form action={run} className="flex flex-wrap items-center gap-3">
        <input type="hidden" name="mode" value="preview" />
        <Button type="submit" variant="secondary" loading={pending}>
          Show what would be deleted
        </Button>
      </form>
      {state.error ? <p role="alert" className="text-body text-pill-negative-ink">{state.error}</p> : null}
      {p ? (
        <div className="flex min-w-0 flex-col gap-2">
          <p role="status" className="m-0 text-body">
            {state.done ? "Done. " : ""}
            {p.items.length === 0
              ? `Nothing to ${state.done ? "delete" : "delete right now"}: no video was uploaded more than ${p.days} days ago with files left.`
              : `${state.done ? "Removed" : "Would remove"} ${p.files} working file${p.files === 1 ? "" : "s"} (${mb(p.bytes)}) and move ${p.assets} picture${p.assets === 1 ? "" : "s"} (${mb(p.assetBytes)}) to the trash, from ${p.items.length} video${p.items.length === 1 ? "" : "s"}.`}
          </p>
          {p.items.length > 0 ? (
            <ul className="m-0 flex list-none flex-col gap-1 p-0 text-small text-muted">
              {p.items.map((i) => (
                <li key={i.videoId} className="[overflow-wrap:anywhere]">
                  {i.topic}: {i.files} file{i.files === 1 ? "" : "s"} ({mb(i.bytes)}), {i.assets} picture{i.assets === 1 ? "" : "s"}
                </li>
              ))}
            </ul>
          ) : null}
          {p.items.length > 0 && !state.done ? (
            <form action={run} className="flex flex-wrap items-center gap-3">
              <input type="hidden" name="mode" value="run" />
              <Button type="submit" variant="destructive" loading={pending}>
                Delete these now
              </Button>
            </form>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
