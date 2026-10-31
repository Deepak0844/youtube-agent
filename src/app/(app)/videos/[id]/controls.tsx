"use client";

import { useActionState, useState, useTransition } from "react";
import { Button } from "@/ui/primitives/button";
import { recheckScenesAction, requestSceneRepairAction, undoScenesAction, type SceneActionState } from "../../queue/scenes-actions";
import { rerunStageAction, type RerunState } from "./actions";

/** "Run again" for one failed or cancelled step, with the time and cost stated before the click. */
export function RerunForm({ videoId, stage, label, estimate, costNote }: { videoId: string; stage: string; label: string; estimate: string; costNote: string }) {
  const [state, run, pending] = useActionState<RerunState, FormData>(rerunStageAction, {});
  return (
    <form action={run} className="flex min-w-0 flex-col gap-2">
      <input type="hidden" name="videoId" value={videoId} />
      <input type="hidden" name="stage" value={stage} />
      <p className="m-0 text-small text-muted">Takes {estimate}. {costNote}</p>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="secondary" disabled={pending} aria-label={`Run ${label} again`}>Run {label} again</Button>
        {state.message ? <p role={state.ok ? "status" : "alert"} className={state.ok ? "m-0 text-body text-pill-positive-ink" : "m-0 text-body text-pill-negative-ink"}>{state.message}</p> : null}
      </div>
    </form>
  );
}

/** Free scene actions (no model call, no money). */
export function SceneButtons({ videoId }: { videoId: string }) {
  const [res, setRes] = useState<SceneActionState | null>(null);
  const [pending, start] = useTransition();
  const [failed, setFailed] = useState(false);
  const go = (f: (id: string) => Promise<SceneActionState>) => start(async () => {
    const r = await f(videoId);
    if (f === recheckScenesAction) setFailed(!r.ok && (r.problems?.length ?? 0) > 0);
    setRes(r);
  });
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap gap-3">
        <Button type="button" variant="secondary" disabled={pending} onClick={() => go(recheckScenesAction)}>Re-check scenes (free)</Button>
        {failed ? <Button type="button" variant="secondary" disabled={pending} onClick={() => go((id) => requestSceneRepairAction(id))}>Repair failing scenes</Button> : null}
        <Button type="button" variant="secondary" disabled={pending} onClick={() => go(undoScenesAction)}>Undo last scene change</Button>
      </div>
      {res ? (
        <div role={res.ok ? "status" : "alert"} className="text-body">
          <p className={res.ok ? "m-0 text-pill-positive-ink" : "m-0 text-pill-negative-ink"}>{res.message}</p>
          {res.problems?.length ? <ul className="m-0 mt-1 pl-5 text-muted">{res.problems.map((p, i) => <li key={i} className="[overflow-wrap:anywhere]">{p}</li>)}</ul> : null}
        </div>
      ) : null}
    </div>
  );
}
