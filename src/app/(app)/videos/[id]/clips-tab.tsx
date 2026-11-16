import { loadClipsTab } from "@/server/db/clips-tab";
import { getPool } from "@/server/db/pool";
import { mediaSigner } from "@/server/db/queue-data";
import type { VideoPage } from "@/server/db/video-page";
import { ClipBatchForm, CutClipsForm } from "./clips-forms";

// The Clips tab (Clip Factory): short clips cut from this finished video. "Cut clips" runs the free, local step; the newest batch is shown with each
// clip's checks; the owner ticks the clips to turn into Shorts. Read only except those two buttons. Nothing is approved or published from here.
export async function ClipsTabPanel({ p }: { p: VideoPage }) {
  const t = await loadClipsTab(getPool(), p.head.id);
  const sign = await mediaSigner(getPool());
  return (
    <>
      <CutClipsForm videoId={p.head.id} again={t.batch !== null} disabled={!t.canCut || t.busy} />
      {!t.canCut ? <p className="m-0 text-small text-muted">Clips can be cut once this video has finished and passed its checks.</p> : null}
      {t.busy ? <p className="m-0 text-small text-muted">Cutting clips now. This takes a few minutes.</p> : null}
      {t.failure ? <p role="alert" data-testid="clips-failure" className="m-0 text-body text-pill-negative-ink">The last try failed: {t.failure}</p> : null}
      {t.batch === null ? (
        <p className="m-0 text-body text-muted">No clips yet. Each press of the button cuts a new batch of up to 10 short clips (15 to 58 seconds, cut at sentence ends) with captions.</p>
      ) : (
        <>
          <h3 className="m-0 text-section font-medium">Batch {t.batch}: {t.clips.length} clips{t.needAttention > 0 ? `, ${t.needAttention} with a check to look at` : ""}</h3>
          <ClipBatchForm videoId={p.head.id} batch={t.batch} clips={t.clips.map((c) => ({ id: c.id, hook: c.hook, durationS: c.durationS, src: sign ? sign(c.file) : null, warnings: c.warnings, short: c.short }))} />
        </>
      )}
    </>
  );
}
