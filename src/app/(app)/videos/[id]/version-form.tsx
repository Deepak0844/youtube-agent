"use client";

import Link from "next/link";
import { useActionState } from "react";
import { KIND_WORDS, VERSION_KINDS } from "@/server/core/videos-view";
import { Button } from "@/ui/primitives/button";
import { makeVersionAction, type VersionState } from "./version-actions";

const SELECT = "w-full max-w-[32ch] rounded-control border border-control bg-ground px-3 py-2 text-body";

/** Remake this Short as another video type, on the same topic. Starts a new video (the same caps apply); this video is not touched. */
export function MakeVersionForm({ videoId, kind }: { videoId: string; kind: string }) {
  const [state, run, pending] = useActionState<VersionState, FormData>(makeVersionAction, {});
  return (
    <form action={run} data-testid="make-version" className="flex min-w-0 flex-col gap-2">
      <input type="hidden" name="videoId" value={videoId} />
      <p className="m-0 max-w-[68ch] text-small text-muted">Start a new video on the same topic as another type. It begins from the topic, notes and language only; nothing of this video is carried over.</p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-body">Make it as
          <select name="kind" defaultValue="" required className={SELECT}>
            <option value="" disabled>Pick a video type</option>
            {VERSION_KINDS.filter((k) => k !== kind).map((k) => <option key={k} value={k}>{KIND_WORDS[k]}</option>)}
          </select>
        </label>
        <Button type="submit" variant="secondary" loading={pending}>Start a new version</Button>
        {state.message ? <p role={state.ok ? "status" : "alert"} className={state.ok ? "m-0 text-body text-pill-positive-ink" : "m-0 text-body text-pill-negative-ink"}>{state.message}</p> : null}
        {state.ok && state.videoId ? <Link href={`/videos/${state.videoId}`} className="text-body underline">Open the new video</Link> : null}
      </div>
    </form>
  );
}
