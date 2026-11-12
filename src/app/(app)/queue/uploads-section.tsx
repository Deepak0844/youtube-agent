import type { UploadListRow } from "@/server/db/upload-actions";
import { Pill } from "@/ui/primitives/pill";
import { CheckOnYoutubeForm, RetryUploadForm } from "./forms";

const ist = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
const LABEL: Record<UploadListRow["status"], string> = { publish_approved: "Approved, waiting", uploading: "Uploading", uploaded: "Uploaded", upload_failed: "Failed" };

// Studio and watch links are built only from ids that passed a strict pattern when they were stored.
const studio = (id: string) => `https://studio.youtube.com/video/${encodeURIComponent(id)}/edit`;
const watch = (id: string) => `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;

/** Every upload with where it stands. An unclear outcome never offers a re-send before "Check on YouTube" found nothing. */
export function UploadsSection({ rows }: { rows: UploadListRow[] }) {
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby="uploads-h" data-testid="uploads-list" className="flex flex-col gap-3 rounded-card border border-border bg-surface p-pad">
      <h2 id="uploads-h" className="text-title font-semibold">Uploads</h2>
      <ul className="m-0 flex list-none flex-col gap-4 p-0">
        {rows.map((u) => (
          <li key={u.id} data-testid="upload-row" data-status={u.status} className="flex min-w-0 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 text-body font-medium [overflow-wrap:anywhere]">{u.topic}</span>
              <Pill tone={u.status === "uploaded" && !u.keptPrivate ? "positive" : u.status === "upload_failed" ? "warning" : "neutral"}>{u.unclear ? "Unclear" : LABEL[u.status]}</Pill>
            </div>
            <p className="m-0 text-small text-muted">
              {u.channelTitle ?? "channel not found"} · {u.visibility ?? "visibility not set"}
              {u.publishAt ? ` · goes live ${ist.format(new Date(u.publishAt))} IST` : ""}
              {u.status === "uploading" && u.bytesTotal ? ` · ${Math.round((u.bytesSent / u.bytesTotal) * 100)}%` : ""}
            </p>
            {u.status === "uploaded" && u.youtubeId ? (
              u.keptPrivate ? (
                <p role="note" className="m-0 max-w-[68ch] rounded-card bg-pill-warning-bg p-3 text-body text-pill-warning-ink">
                  YouTube kept it private (project not audited): <a className="underline" href={studio(u.youtubeId)} target="_blank" rel="noreferrer">open Studio</a> to change it.
                </p>
              ) : (
                <p className="m-0 text-body"><a className="underline" href={watch(u.youtubeId)} target="_blank" rel="noreferrer">Open on YouTube</a></p>
              )
            ) : null}
            {u.status === "upload_failed" && u.unclear ? (
              <div className="flex flex-col gap-2">
                <p role="note" className="m-0 max-w-[68ch] rounded-card bg-pill-warning-bg p-3 text-body text-pill-warning-ink">
                  Check YouTube Studio first: this video may already be live. Nothing is sent again on its own.
                  {u.checkedNotFound ? " The channel's recent uploads did not show it." : ""}
                </p>
                <div className="flex flex-wrap items-center gap-3">
                  <CheckOnYoutubeForm uploadId={u.id} topic={u.topic} />
                  {u.checkedNotFound ? <RetryUploadForm uploadId={u.id} topic={u.topic} /> : null}
                </div>
              </div>
            ) : null}
            {u.status === "upload_failed" && !u.unclear ? (
              <div className="flex flex-col gap-2">
                <p role="note" className="m-0 max-w-[68ch] text-body text-pill-negative-ink [overflow-wrap:anywhere]">{u.reason ?? "The upload failed."} Nothing was published.</p>
                <RetryUploadForm uploadId={u.id} topic={u.topic} />
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
