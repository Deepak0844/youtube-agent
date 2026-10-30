"use client";

import { useActionState } from "react";
import type { AssetSettingsView } from "@/server/db/asset-settings";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { Label } from "@/ui/primitives/label";
import { saveAssetSettingsAction, type FormState } from "./actions";

const fields = (v: AssetSettingsView): Array<{ name: string; label: string; max: number; value: number }> => [
  { name: "retention_days", label: "Days to keep uploads after a video is finished", max: 60, value: v.retentionDays },
  { name: "unused_days", label: "Days to keep an upload no video uses", max: 365, value: v.unusedDays },
  { name: "trash_days", label: "Days a deleted file stays in the trash", max: 60, value: v.trashDays },
  { name: "max_image_mb", label: "Biggest photo (MB)", max: 1024, value: v.maxImageMb },
  { name: "max_audio_mb", label: "Biggest sound file (MB)", max: 4096, value: v.maxAudioMb },
  { name: "max_megapixels", label: "Biggest photo (megapixels)", max: 500, value: v.maxMegapixels },
  { name: "max_batch_files", label: "Most files in one upload", max: 1000, value: v.maxBatchFiles },
  { name: "total_gb", label: "Total space for uploads (GB)", max: 1000, value: v.totalGb },
];

export function AssetSettingsForm({ view }: { view: AssetSettingsView }) {
  const [state, action, pending] = useActionState<FormState, FormData>(saveAssetSettingsAction, {});
  return (
    <form action={action} className="flex flex-col gap-5">
      <div className="grid gap-4 sm:grid-cols-2">
        {fields(view).map((f) => (
          <div key={f.name} className="flex min-w-0 flex-col gap-2">
            <Label htmlFor={f.name}>{f.label}</Label>
            <Input id={f.name} name={f.name} type="number" inputMode="numeric" min={1} max={f.max} step={1} required defaultValue={f.value} />
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" disabled={pending}>Save settings</Button>
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
