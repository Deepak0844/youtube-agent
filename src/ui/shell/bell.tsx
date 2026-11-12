import Link from "next/link";
import { Bell } from "lucide-react";
import { requireOwner } from "@/lib/auth/require-owner";
import { markAllReadAction } from "@/app/_actions/notifications";
import { getPool } from "@/server/db/pool";
import { listNotifications, unreadCount } from "@/server/db/notify";
import { cn, focusRing } from "../lib/cn";

const when = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ") + " UTC";

/** Bell with the unread count and the latest messages. No client JS: a <details> menu and one form. Reads the session, so it sits in <Suspense>. */
export async function NotificationBell() {
  await requireOwner();
  let unread = 0;
  let items: Awaited<ReturnType<typeof listNotifications>> = [];
  try {
    const db = getPool();
    [unread, items] = await Promise.all([unreadCount(db), listNotifications(db, { limit: 10 })]);
  } catch {
    // The bell is a convenience: a database hiccup shows an empty bell, never an error page.
  }
  return (
    <details className="relative" data-testid="bell">
      <summary
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications, none unread"}
        className={cn("relative flex size-9 cursor-pointer list-none items-center justify-center rounded-control text-muted marker:hidden", focusRing)}
      >
        <Bell size={18} aria-hidden />
        {unread > 0 ? (
          <span data-testid="bell-count" className="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-text px-1 text-center text-[10px] leading-4 font-semibold text-ground">
            {unread > 99 ? "99+" : unread}
          </span>
        ) : null}
      </summary>
      <div className="absolute right-0 z-20 mt-2 w-80 rounded-card max-sm:fixed max-sm:inset-x-4 max-sm:top-14 max-sm:w-auto bg-raised p-3 overlay-lift" role="region" aria-label="Notifications">
        {items.length === 0 ? (
          <p className="text-body text-muted">Nothing yet.</p>
        ) : (
          <ul className="flex max-h-96 flex-col gap-2 overflow-y-auto">
            {items.map((n) => (
              <li key={n.id} data-testid="bell-item" className={cn("text-body", n.readAt ? "text-muted" : "text-text")}>
                <p className="font-medium">{n.title}</p>
                {n.text ? <p className="text-small">{n.text}</p> : null}
                <p className="text-small text-faint">{when(n.at)}</p>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3 flex items-center justify-between gap-3 text-small">
          <Link href="/settings/notifications" className={cn("rounded-control underline", focusRing)}>Notification settings</Link>
          {unread > 0 ? (
            <form action={markAllReadAction}>
              <button type="submit" className={cn("rounded-control underline", focusRing)}>Mark all read</button>
            </form>
          ) : null}
        </div>
      </div>
    </details>
  );
}
