import Link from "next/link";
import { Bell, Check, CheckCheck, CircleAlert, CircleCheck, CircleX } from "lucide-react";
import { requireOwner } from "@/lib/auth/require-owner";
import { markAllReadAction, markOneReadAction } from "@/app/_actions/notifications";
import { getPool } from "@/server/db/pool";
import { listNotifications, unreadCount } from "@/server/db/notify";
import { bellItem } from "@/server/core/notify-view";
import { TimeAgo } from "../states/time-ago";
import { cn, focusRing } from "../lib/cn";

const ICON = { needs_you: CircleAlert, problems: CircleX, good_news: CircleCheck } as const;
const TONE = { needs_you: "text-pill-warning-ink bg-pill-warning-bg", problems: "text-pill-negative-ink bg-pill-negative-bg", good_news: "text-pill-positive-ink bg-pill-positive-bg" } as const;

/**
 * Bell with the unread count and the latest messages (UI redesign): a header with Mark all read, one row per message with
 * an icon for its kind, the step in words, the time (exact IST on hover) and a link to the video or queue item.
 * No client JS beyond the time labels: a <details> menu and one form. Reads the session, so it sits in <Suspense>.
 */
export async function NotificationBell() {
  await requireOwner();
  let unread = 0;
  let rows: Awaited<ReturnType<typeof listNotifications>> = [];
  try {
    const db = getPool();
    [unread, rows] = await Promise.all([unreadCount(db), listNotifications(db, { limit: 12 })]);
  } catch {
    // The bell is a convenience: a database hiccup shows an empty bell, never an error page.
  }
  return (
    <details className="relative" data-testid="bell">
      <summary
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications, none unread"}
        className={cn("relative flex size-9 cursor-pointer list-none items-center justify-center rounded-control text-muted hover:bg-raised hover:text-text marker:hidden [&::-webkit-details-marker]:hidden", focusRing)}
      >
        <Bell size={18} aria-hidden />
        {unread > 0 ? (
          <span data-testid="bell-count" className="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-negative px-1 text-center text-[10px] leading-4 font-semibold text-page">
            {unread > 99 ? "99+" : unread}
          </span>
        ) : null}
      </summary>
      <div
        role="region"
        aria-label="Notifications"
        className="ui-pop absolute right-0 z-30 mt-2 flex w-96 flex-col overflow-hidden rounded-card border border-border bg-surface text-text overlay-lift max-sm:fixed max-sm:inset-x-3 max-sm:top-14 max-sm:w-auto"
      >
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <p className="flex items-center gap-2 text-section font-semibold">
            Notifications
            {unread > 0 ? <span className="rounded-full bg-raised px-2 text-small font-medium text-muted">{unread} new</span> : null}
          </p>
          <form action={markAllReadAction}>
            <button
              type="submit"
              disabled={unread === 0}
              className={cn("flex items-center gap-1.5 rounded-control px-1.5 py-1 text-small text-muted hover:bg-raised hover:text-text disabled:pointer-events-none disabled:opacity-50", focusRing)}
            >
              <CheckCheck size={14} aria-hidden />
              Mark all read
            </button>
          </form>
        </div>
        {rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
            <CircleCheck size={20} aria-hidden className="text-muted" />
            <p className="text-body font-medium">You are all caught up</p>
            <p className="text-small text-muted">Approvals, problems and good news show up here.</p>
          </div>
        ) : (
          <ul className="flex max-h-[26rem] flex-col overflow-y-auto">
            {rows.map((r) => {
              const b = bellItem(r);
              const Icon = ICON[b.group];
              const body = (
                <>
                  <span aria-hidden className={cn("mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full", TONE[b.group])}>
                    <Icon size={15} />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className={cn("text-body", b.unread ? "font-semibold text-text" : "font-medium text-muted")}>{b.title}</span>
                    {b.detail ? <span className="line-clamp-2 text-small text-muted [overflow-wrap:anywhere]">{b.detail}</span> : null}
                    <span className="text-small text-faint">
                      <TimeAgo at={r.at} />
                    </span>
                  </span>
                  {b.unread ? (
                    <span className="mt-2 size-2 shrink-0 rounded-full bg-info">
                      <span className="sr-only">Unread</span>
                    </span>
                  ) : null}
                </>
              );
              return (
                <li key={r.id} data-testid="bell-item" className="group flex items-stretch border-b border-border last:border-0">
                  {b.href ? (
                    <Link href={b.href} className={cn("flex min-w-0 flex-1 gap-3 px-4 py-3 hover:bg-raised", focusRing)}>
                      {body}
                    </Link>
                  ) : (
                    <div className="flex min-w-0 flex-1 gap-3 px-4 py-3">{body}</div>
                  )}
                  {b.unread ? (
                    <form action={markOneReadAction} className="flex items-start pt-2.5 pr-2">
                      <input type="hidden" name="id" value={r.id} />
                      <button
                        type="submit"
                        aria-label={`Mark as read: ${b.title}`}
                        title="Mark as read"
                        className={cn("flex size-7 items-center justify-center rounded-control text-faint hover:bg-raised hover:text-text", focusRing)}
                      >
                        <Check size={14} aria-hidden />
                      </button>
                    </form>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        <div className="border-t border-border px-4 py-2.5">
          <Link href="/settings/notifications" className={cn("rounded-control text-small text-muted hover:text-text", focusRing)}>
            Notification settings
          </Link>
        </div>
      </div>
    </details>
  );
}
