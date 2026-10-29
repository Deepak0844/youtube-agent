import { Button } from "@/ui/primitives/button";
import { Progress } from "@/ui/primitives/progress";
import type { UploadState } from "./upload-status";

const LABEL: Record<UploadState, string> = { ready: "Ready to upload", sending: "Sending", checking: "Waiting to be checked", done: "Added", failed: "" };

/** One file in the upload list. The name is plain text (React escapes it once). */
export function UploadRow(p: { name: string; state: UploadState; percent: number; message?: string; onCancel: () => void }) {
  return (
    <li className="flex min-w-0 flex-col gap-2 rounded-card bg-raised p-3" data-state={p.state}>
      <div className="flex min-w-0 items-center justify-between gap-3">
        <span className="min-w-0 truncate text-body">{p.name}</span>
        {p.state === "sending" || p.state === "ready" ? (
          <Button variant="ghost" onClick={p.onCancel} aria-label={`Cancel ${p.name}`}>
            Cancel
          </Button>
        ) : null}
      </div>
      {p.state === "sending" ? <Progress value={p.percent} aria-label={`Sending ${p.name}`} /> : null}
      <p className={`text-small ${p.state === "failed" ? "text-pill-negative-ink" : "text-muted"}`} role={p.state === "failed" ? "alert" : undefined}>
        {p.state === "failed" ? p.message : LABEL[p.state]}
      </p>
    </li>
  );
}
