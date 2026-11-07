import Link from "next/link";
import { formatIst } from "@/server/core/display-format";
import type { UploadLine } from "@/server/db/calendar-data";

const LABEL: Record<string, string> = {
  publish_approved: "Approved, waiting to upload",
  uploading: "Uploading",
  upload_failed: "Upload failed",
  uploaded: "Uploaded",
};

/** Read only list of uploads; each topic links to its video page. */
export function UploadList({ rows, empty }: { rows: UploadLine[]; empty: string }) {
  if (rows.length === 0) return <p className="m-0 text-body text-muted">{empty}</p>;
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0">
      {rows.map((r) => (
        <li key={`${r.videoId}-${r.status}-${r.at?.getTime() ?? 0}`} className="min-w-0 text-body [overflow-wrap:anywhere]" data-testid="upload-row">
          <Link href={`/videos/${r.videoId}`} className="font-medium underline underline-offset-2">{r.topic}</Link>
          <span className="text-muted"> · {LABEL[r.status] ?? r.status}{r.at ? ` · ${formatIst(r.at)}` : ""}</span>
        </li>
      ))}
    </ul>
  );
}
