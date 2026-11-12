import { Suspense } from "react";
import { PageSkeleton } from "@/ui/states/page-skeleton";
import { requireOwner } from "@/lib/auth/require-owner";
import { LIVE_PHRASE } from "@/server/core/comments";
import { loadEngagement, type CommentView, type EngagementView } from "@/server/db/comments";
import { getPool } from "@/server/db/pool";
import { Pill } from "@/ui/primitives/pill";
import { ApproveForm, DraftForm, DryRunForm, EditForm, IgnoreForm, ResolveForm, SyncForm } from "./forms";

export const metadata = { title: "Engagement" };

export default function EngagementPage() {
  return (
    <Suspense fallback={<PageSkeleton variant="form" />}>
      <Owned />
    </Suspense>
  );
}

// Comment text is written by strangers. It is rendered ONLY as escaped plain text (never HTML, never a link), wrapped so a long
// word cannot break the layout.
const plain = "m-0 whitespace-pre-wrap text-body [overflow-wrap:anywhere]";

const STATUS: Record<string, { label: string; tone: "positive" | "negative" | "warning" | "neutral" }> = {
  new: { label: "New", tone: "neutral" },
  held: { label: "Needs your eyes", tone: "warning" },
  drafted: { label: "Draft waiting", tone: "neutral" },
  approved: { label: "Posting", tone: "warning" },
  posted: { label: "Posted", tone: "positive" },
  ignored: { label: "Ignored", tone: "neutral" },
  failed: { label: "Failed", tone: "negative" },
};

const waiting = (c: CommentView) => c.reply !== null && (c.reply.status === "held" || c.reply.status === "dry_run") && c.status !== "ignored";

function Waiting({ c, video, dryRun }: { c: CommentView; video: string; dryRun: boolean }) {
  const r = c.reply!;
  return (
    <li data-testid="held-reply" className="flex min-w-0 flex-col gap-3 rounded-card border border-border bg-surface p-pad">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-small text-muted [overflow-wrap:anywhere]">{video}</span>
        {c.needsEyes ? <Pill tone="warning">Needs your eyes</Pill> : null}
        {r.status === "dry_run" ? <Pill tone="neutral">Dry run recorded</Pill> : <Pill tone="neutral">Held for review</Pill>}
      </div>
      <div className="flex flex-col gap-1">
        <p className="m-0 text-small text-muted">
          {c.author || "A viewer"} wrote{c.publishedIst ? ` (${c.publishedIst} IST)` : ""}
        </p>
        <p className={plain}>{c.text}</p>
      </div>
      {c.needsEyes && c.riskReasons.length > 0 ? <p role="note" className="m-0 rounded-card bg-pill-warning-bg p-3 text-body text-pill-warning-ink">Why: {c.riskReasons.join(", ")}.</p> : null}
      <div className="flex flex-col gap-1">
        <p className="m-0 text-small text-muted">Your reply (draft)</p>
        <p className={plain}>{r.text}</p>
      </div>
      {r.status === "dry_run" && r.wouldSend ? <p className="m-0 text-small text-faint">Dry run: this would have been sent as a reply to comment {r.wouldSend.parentId ?? "?"}. Nothing was sent.</p> : null}
      <ApproveForm replyId={r.id} seen={r.seen} needsEyes={c.needsEyes} dryRun={dryRun} />
      <div className="flex flex-wrap items-start gap-4">
        <EditForm replyId={r.id} text={r.text} />
        <IgnoreForm commentId={c.id} />
      </div>
    </li>
  );
}

function CommentRow({ c }: { c: CommentView }) {
  const st = STATUS[c.status] ?? { label: c.status, tone: "neutral" as const };
  return (
    <li data-testid="comment-row" className="flex min-w-0 flex-col gap-2 border-t border-border pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-small text-muted [overflow-wrap:anywhere]">{c.author || "A viewer"}</span>
        <Pill tone={st.tone}>{st.label}</Pill>
        {c.publishedIst ? <span className="text-small text-faint">{c.publishedIst} IST</span> : null}
      </div>
      <p className={plain}>{c.text}</p>
      {c.reply && !waiting(c) ? <p className={`${plain} text-muted`}>Reply: {c.reply.text}</p> : null}
      {c.reply && (c.reply.status === "failed" || c.reply.status === "approved") ? <ResolveForm replyId={c.reply.id} /> : null}
      {c.reply?.error ? <p role="note" className="m-0 max-w-[68ch] rounded-card bg-pill-warning-bg p-3 text-body text-pill-warning-ink [overflow-wrap:anywhere]">{c.reply.error}</p> : null}
    </li>
  );
}

function Header({ view }: { view: EngagementView }) {
  return (
    <header className="flex flex-col gap-3">
      <h1 className="text-page-title font-semibold tracking-tight">Engagement</h1>
      <p className="max-w-[68ch] text-body text-muted">
        Comments on your uploaded videos. Run now reads them from YouTube (it only reads). Replies are drafted for you and always wait here: nothing is
        posted until you press Approve and post on that one reply.
      </p>
      <SyncForm />
      <p className="m-0 text-small text-faint" data-testid="last-sync">
        {view.lastSyncIst ? `Last synced ${view.lastSyncIst} IST` : "Never synced"}
      </p>
      {view.dryRun ? (
        <p role="note" data-testid="dry-run-banner" className="m-0 max-w-[68ch] rounded-card bg-pill-warning-bg p-4 text-body text-pill-warning-ink">
          Dry run is on. Approve and post only records what would be sent. Nothing is posted to YouTube.
        </p>
      ) : (
        <p role="note" data-testid="live-banner" className="m-0 max-w-[68ch] rounded-card bg-pill-negative-bg p-4 text-body text-pill-negative-ink">
          Dry run is off. Approve and post really posts the reply to YouTube under your channel name.
        </p>
      )}
      {view.killSwitch ? <p role="note" className="m-0 max-w-[68ch] rounded-card bg-pill-negative-bg p-4 text-body text-pill-negative-ink">The kill switch is on, so nothing is posted.</p> : null}
      <ul className="m-0 flex list-none flex-col gap-1 p-0 text-body" data-testid="replies-used">
        {view.used.length === 0 ? <li className="text-muted">No channel connected yet.</li> : null}
        {view.used.map((u) => (
          <li key={u.channelId}>
            {u.title}: {u.used} of {view.cap} replies used today ({view.dryRun ? "dry run" : "posted"}, Pacific day). At least {view.gapSeconds} seconds between replies.
          </li>
        ))}
      </ul>
      <details className="max-w-[68ch] text-body">
        <summary className="min-h-11 cursor-pointer py-2">Dry run switch</summary>
        <DryRunForm dryRun={view.dryRun} phrase={LIVE_PHRASE} />
      </details>
    </header>
  );
}

async function Owned() {
  await requireOwner();
  const view = await loadEngagement(getPool());
  const queue = view.videos.flatMap((v) => v.comments.filter(waiting).map((c) => ({ c, topic: v.topic })));
  return (
    <div className="grid min-w-0 gap-layout xl:grid-cols-2 xl:items-start">
      <div className="min-w-0 xl:col-span-2"><Header view={view} /></div>
      <section aria-labelledby="queue-h" className="flex flex-col gap-3">
        <h2 id="queue-h" className="text-title font-semibold">Replies waiting for you ({queue.length})</h2>
        {queue.length === 0 ? (
          <p className="rounded-card border border-border bg-surface p-pad text-body text-muted">No replies are waiting. New drafts appear here after a sync.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {queue.map(({ c, topic }) => (
              <Waiting key={c.id} c={c} video={topic} dryRun={view.dryRun} />
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="videos-h" className="flex flex-col gap-3">
        <h2 id="videos-h" className="text-title font-semibold">Comments by video</h2>
        {view.videos.length === 0 ? (
          <p className="rounded-card border border-border bg-surface p-pad text-body text-muted">No comments yet. Press Run now after a video is uploaded.</p>
        ) : (
          view.videos.map((v) => (
            <div key={v.videoId} data-testid="video-comments" className="flex min-w-0 flex-col gap-3 rounded-card border border-border bg-surface p-pad">
              <div className="flex flex-col gap-1">
                <span className="min-w-0 text-body font-medium [overflow-wrap:anywhere]">{v.topic}</span>
                <span className="text-small text-muted">{v.channelTitle ?? "channel not found"}</span>
              </div>
              {v.comments.some((c) => c.status === "new") ? <DraftForm videoId={v.videoId} /> : null}
              <ul className="m-0 flex list-none flex-col gap-3 p-0">
                {v.comments.map((c) => (
                  <CommentRow key={c.id} c={c} />
                ))}
              </ul>
            </div>
          ))
        )}
      </section>
    </div>
  );
}
