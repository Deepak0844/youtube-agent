"use client";

import { useActionState, useState } from "react";
import { Button } from "@/ui/primitives/button";
import { chooseBedAction, earOkAction, type SoundState } from "./sound-actions";

const Msg = ({ s }: { s: SoundState }) => (s.message ? <p role={s.ok ? "status" : "alert"} className={s.ok ? "m-0 text-body text-pill-positive-ink" : "m-0 text-body text-pill-negative-ink"}>{s.message}</p> : null);

/** One list of beds, each with its own player; the radio picks one for this video. Choosing is free and changes nothing until the Sound step is re-run. */
export function BedPicker({ videoId, beds, chosen }: { videoId: string; beds: Array<{ id: string; name: string; tags: string[]; durationS: number | null; src: string | null }>; chosen: string | null }) {
  const [state, run, pending] = useActionState<SoundState, FormData>(chooseBedAction, {});
  const [pick, setPick] = useState(chosen ?? "");
  return (
    <form action={run} className="flex min-w-0 flex-col gap-3">
      <input type="hidden" name="videoId" value={videoId} />
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        <li><label className="flex items-center gap-2 text-body"><input type="radio" name="item" value="" checked={pick === ""} onChange={() => setPick("")} /> No music bed</label></li>
        {beds.map((b) => (
          <li key={b.id} data-testid="bed-option" className="flex min-w-0 flex-col gap-1">
            <label className="flex items-center gap-2 text-body"><input type="radio" name="item" value={b.id} checked={pick === b.id} onChange={() => setPick(b.id)} /> <span className="[overflow-wrap:anywhere]">{b.name}</span>{b.durationS ? <span className="text-small text-faint">{Math.round(b.durationS)} s</span> : null}</label>
            {b.tags.length > 0 ? <span className="text-small text-muted [overflow-wrap:anywhere]">{b.tags.join(", ")}</span> : null}
            {b.src ? <audio controls preload="none" src={b.src} aria-label={`Listen to ${b.name}`} className="w-full max-w-md" /> : <span className="text-small text-muted">No player (media key is locked).</span>}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="secondary" disabled={pending || pick === (chosen ?? "")}>Use this bed</Button>
        <Msg s={state} />
      </div>
    </form>
  );
}

/** The owner's-ear tick. Recorded in the audit log for the current Sound run; nothing waits on it. */
export function EarOkForm({ videoId, done }: { videoId: string; done: boolean }) {
  const [state, run, pending] = useActionState<SoundState, FormData>(earOkAction, {});
  const [ticked, setTicked] = useState(done);
  return (
    <form action={run} className="flex min-w-0 flex-wrap items-center gap-3">
      <input type="hidden" name="videoId" value={videoId} />
      <label className="flex items-center gap-2 text-body"><input type="checkbox" checked={ticked} disabled={done} onChange={(e) => setTicked(e.target.checked)} /> I listened and the sound is OK</label>
      {done ? null : <Button type="submit" variant="secondary" disabled={pending || !ticked}>Save</Button>}
      <Msg s={state} />
    </form>
  );
}
