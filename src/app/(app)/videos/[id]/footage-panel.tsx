import { getPool } from "@/server/db/pool";
import type { VideoPage } from "@/server/db/video-page";
import { SwapClipForm } from "./footage-form";

const asObj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Montage only: the clip each beat shows, with a button to try another one. Read only except that button. */
export async function FootagePanel({ p }: { p: VideoPage }) {
  const { rows } = await getPool().query<{ beat_id: string; credit: string | null }>(
    "select va.beat_id, va.credit from video_assets va join assets a on a.id = va.asset_id where va.video_id = $1 and a.kind = 'video' and a.deleted_at is null order by va.beat_id, va.created_at",
    [p.head.id],
  );
  const credit = new Map(rows.map((r) => [r.beat_id, r.credit ?? "no credit line"]));
  const beats = asObj(p.beats).beats;
  const anyActive = Object.values(p.runStatus).some((r) => r === "queued" || r === "running" || r === "needs_decision");
  const ready = p.runStatus.pictures === "succeeded" && p.runStatus.montage === "succeeded" && !anyActive && !p.hasUpload && (p.head.status === "active" || p.head.status === "waiting");
  if (!Array.isArray(beats) || credit.size === 0) return null;
  return (
    <div data-testid="footage-panel" className="flex min-w-0 flex-col gap-2 rounded-card border border-border bg-surface p-pad">
      <h3 className="m-0 text-section font-medium">Footage</h3>
      <p className="m-0 text-body text-muted">A wrong clip on one beat? Try another. It is free, and the edit, voice, sound and check run again. Approve the video after.</p>
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {beats.map((b) => {
          const id = String(asObj(b).id ?? "");
          if (!credit.has(id)) return null;
          return (
            <li key={id} className="flex min-w-0 flex-col gap-1 border-t border-rule pt-2">
              <span className="text-body font-medium [overflow-wrap:anywhere]">{id}</span>
              <span className="text-small text-muted [overflow-wrap:anywhere]">{credit.get(id)}</span>
              <SwapClipForm videoId={p.head.id} beatId={id} disabled={!ready} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
