"use client";

import { useActionState } from "react";
import { Button } from "@/ui/primitives/button";
import { approveThumbnailAction, makeThumbnailAction, type ThumbnailState } from "./thumbnail-actions";

const SELECT = "w-full max-w-[40ch] rounded-control border border-control bg-ground px-3 py-2 text-body";

const Msg = ({ s }: { s: ThumbnailState }) => (s.message ? <p role={s.ok ? "status" : "alert"} className={s.ok ? "m-0 text-body text-pill-positive-ink" : "m-0 text-body text-pill-negative-ink"}>{s.message}</p> : null);

/** Make (or re-make) the card; optionally with one of the owner's own pictures on it. Free and local. */
export function MakeThumbnailForm({ videoId, again, disabled, pictures }: { videoId: string; again: boolean; disabled: boolean; pictures: Array<{ id: string; name: string }> }) {
  const [state, run, pending] = useActionState<ThumbnailState, FormData>(makeThumbnailAction, {});
  return (
    <form action={run} data-testid="thumbnail-make" className="flex min-w-0 flex-col gap-3">
      <input type="hidden" name="videoId" value={videoId} />
      <label className="flex flex-col gap-1 text-body">Picture on the card (optional)
        <select name="assetId" defaultValue="" className={SELECT}>
          <option value="">No picture: the title only</option>
          {pictures.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="secondary" disabled={pending || disabled}>{again ? "Make the thumbnail again" : "Make the thumbnail"}</Button>
        <Msg s={state} />
      </div>
    </form>
  );
}

/** Approve exactly the card the owner is looking at (the hash it was shown with). */
export function ApproveThumbnailForm({ videoId, seenHash }: { videoId: string; seenHash: string }) {
  const [state, run, pending] = useActionState<ThumbnailState, FormData>(approveThumbnailAction, {});
  return (
    <form action={run} data-testid="thumbnail-approve" className="flex min-w-0 flex-wrap items-center gap-3">
      <input type="hidden" name="videoId" value={videoId} />
      <input type="hidden" name="seenHash" value={seenHash} />
      <Button type="submit" disabled={pending}>Approve this thumbnail</Button>
      <Msg s={state} />
    </form>
  );
}
