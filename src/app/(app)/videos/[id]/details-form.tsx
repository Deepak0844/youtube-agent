"use client";

import { useActionState } from "react";
import type { UploadDetails } from "@/server/core/upload-details";
import { Button } from "@/ui/primitives/button";
import { saveDetailsAction, type DetailsState } from "./details-actions";

const FIELD = "w-full max-w-[68ch] rounded-control border border-control bg-ground px-3 py-2 text-body";

function YesNo({ name, label, hint, value }: { name: string; label: string; hint: string; value: boolean }) {
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0">
      <legend className="p-0 text-body font-medium">{label}</legend>
      <p className="m-0 text-small text-muted">{hint}</p>
      <label className="flex items-center gap-2 text-body"><input type="radio" name={name} value="no" defaultChecked={!value} /> No</label>
      <label className="flex items-center gap-2 text-body"><input type="radio" name={name} value="yes" defaultChecked={value} /> Yes</label>
    </fieldset>
  );
}

/** Upload details: title, description, tags, category, language, made for kids, synthetic content. Saving never uploads anything. */
export function UploadDetailsForm({ videoId, details, saved, channelTitle }: { videoId: string; details: UploadDetails; saved: boolean; channelTitle: string | null }) {
  const [state, run, pending] = useActionState<DetailsState, FormData>(saveDetailsAction, {});
  return (
    <form action={run} data-testid="details-form" className="flex min-w-0 flex-col gap-3">
      <input type="hidden" name="videoId" value={videoId} />
      <p className="m-0 text-small text-muted">
        {saved ? "Saved details." : "Not saved yet: these are suggestions."} {channelTitle ? `Defaults come from the channel "${channelTitle}".` : "No channel is chosen for this video, so general defaults are shown."}
      </p>
      <label className="flex flex-col gap-1 text-body">Title (up to 100 characters, no &lt; or &gt;)
        <input name="title" defaultValue={details.title} maxLength={200} className={FIELD} required />
      </label>
      <label className="flex flex-col gap-1 text-body">Description (up to 5000 bytes)
        <textarea name="description" defaultValue={details.description} rows={8} className={FIELD} />
      </label>
      <label className="flex flex-col gap-1 text-body">Tags (separated by commas, 500 characters in total, no &lt; or &gt;)
        <input name="tags" defaultValue={details.tags.join(", ")} className={FIELD} />
      </label>
      <div className="flex flex-wrap gap-4">
        <label className="flex flex-col gap-1 text-body">Category number (27 = Education)
          <input name="category_id" type="number" min={1} max={99} defaultValue={details.category_id} className="w-28 rounded-control border border-control bg-ground px-3 py-2 text-body" required />
        </label>
        <label className="flex flex-col gap-1 text-body">Language code
          <input name="language" defaultValue={details.language} maxLength={12} className="w-28 rounded-control border border-control bg-ground px-3 py-2 text-body" required />
        </label>
      </div>
      <YesNo name="made_for_kids" label="Is this video made for kids?" hint="Your choice, shown every time. It starts from the channel setting (No unless the channel says yes)." value={details.made_for_kids} />
      <YesNo name="synthetic_content" label="Does it show altered or synthetic content that looks real?" hint="YouTube asks this. It starts from the channel default." value={details.synthetic_content} />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending}>Save details</Button>
        {state.message ? <p role={state.ok ? "status" : "alert"} className={state.ok ? "m-0 text-body text-pill-positive-ink" : "m-0 text-body text-pill-negative-ink"}>{state.message}</p> : null}
      </div>
    </form>
  );
}
