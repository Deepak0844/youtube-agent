"use client";

import { useActionState } from "react";
import { LANGUAGE_ORDER, LANGUAGE_WORDS } from "@/server/core/videos-view";
import type { IdeaRow } from "@/server/db/ideas";
import { cn, control, fade, focusRing } from "@/ui/lib/cn";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { Label } from "@/ui/primitives/label";
import { addIdeaAction, dismissIdeaAction, draftIdeaAction, type IdeaFormState } from "./actions";

const selectClass = cn("w-full rounded-control border border-control bg-surface px-4 text-body text-text disabled:opacity-50", control, fade, focusRing);
const areaClass = cn("w-full rounded-control border border-control bg-surface px-4 py-2 text-body text-text", control, fade, focusRing);

function Msg({ s }: { s: IdeaFormState }) {
  return s.error ? <p role="alert" className="m-0 text-body text-pill-negative-ink">{s.error}</p> : s.ok ? <p role="status" className="m-0 text-body text-pill-positive-ink">Done.</p> : null;
}

export function AddIdeaForm() {
  const [state, run, pending] = useActionState<IdeaFormState, FormData>(addIdeaAction, {});
  return (
    <form action={run} className="flex min-w-0 max-w-xl flex-col gap-4 rounded-card bg-surface p-pad">
      <h2 className="text-title font-semibold">Add an idea</h2>
      <div className="flex flex-col gap-2">
        <Label htmlFor="idea-topic">Topic</Label>
        <Input id="idea-topic" name="topic" required minLength={8} maxLength={200} autoComplete="off" placeholder="How a hash map finds a key in one step" />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="idea-hook">Hook (optional)</Label>
        <Input id="idea-hook" name="hook" maxLength={300} autoComplete="off" />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="idea-why">Why now (optional)</Label>
        <Input id="idea-why" name="why" maxLength={400} autoComplete="off" />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="idea-sources">Sources (optional, one https link per line, up to 4)</Label>
        <textarea id="idea-sources" name="sources" rows={3} className={areaClass} />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="idea-score">Score (2 to 10)</Label>
        <Input id="idea-score" name="score" type="number" inputMode="decimal" min={2} max={10} step={0.5} defaultValue={6} />
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" disabled={pending}>Add idea</Button>
        <Msg s={state} />
      </div>
    </form>
  );
}

export function IdeaCard({ idea }: { idea: IdeaRow }) {
  const [dismissState, dismiss, dismissing] = useActionState<IdeaFormState, FormData>(dismissIdeaAction, {});
  const [draftState, draft, drafting] = useActionState<IdeaFormState, FormData>(draftIdeaAction, {});
  const waiting = idea.status === "proposed";
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-2">
        <h3 className="m-0 min-w-0 break-words text-body font-semibold">{idea.topic}</h3>
        <span className="text-small text-muted">Score {idea.score}</span>
      </div>
      {idea.hook ? <p className="m-0 break-words text-body"><span className="font-medium">Hook:</span> {idea.hook}</p> : null}
      {idea.why ? <p className="m-0 break-words text-body text-muted"><span className="font-medium">Why:</span> {idea.why}</p> : null}
      {idea.sources.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-1 p-0 text-small">
          {idea.sources.map((s) => (
            <li key={s} className="min-w-0 break-all">{s}</li>
          ))}
        </ul>
      ) : null}
      {waiting ? (
        <div className="flex flex-wrap items-end gap-3">
          <form action={draft} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="id" value={idea.id} />
            <div className="flex flex-col gap-1">
              <Label htmlFor={`kind-${idea.id}`}>Video type</Label>
              <select id={`kind-${idea.id}`} name="kind" defaultValue="scene_kit" className={selectClass}>
                <option value="scene_kit">Scene kit</option>
                <option value="tsx">Custom animation (TSX)</option>
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={`lang-${idea.id}`}>Language</Label>
              <select id={`lang-${idea.id}`} name="language" defaultValue="en" className={selectClass}>
                {LANGUAGE_ORDER.map((l) => (
                  <option key={l} value={l}>{LANGUAGE_WORDS[l]} ({l})</option>
                ))}
              </select>
            </div>
            <Button type="submit" disabled={drafting}>Draft now</Button>
          </form>
          <form action={dismiss}>
            <input type="hidden" name="id" value={idea.id} />
            <Button type="submit" variant="secondary" disabled={dismissing}>Dismiss</Button>
          </form>
        </div>
      ) : (
        <p className="m-0 text-small text-muted">{idea.status === "drafted" && idea.videoId ? <a className="underline" href={`/videos/${idea.videoId}`}>Drafted: open the video</a> : "Drafting..."}</p>
      )}
      <Msg s={draftState.error ? draftState : dismissState} />
    </div>
  );
}
