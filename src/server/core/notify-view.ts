// How one bell notification is shown (UI redesign): its group (for the icon and colour), the step in words, and where a
// click goes. Needs-you events open the queue item; everything else opens the video.
import { isNotifyEvent, NOTIFY_EVENTS, type NotifyGroup } from "./notify";
import { STAGE_LABELS } from "./video-page-view";

export interface BellRow {
  id: string;
  at: Date;
  event: string;
  videoId: string | null;
  title: string;
  text: string | null;
  readAt: Date | null;
}
export interface BellItem {
  group: NotifyGroup;
  title: string;
  detail: string | null;
  href: string | null;
  unread: boolean;
}

export function bellItem(r: BellRow): BellItem {
  const group: NotifyGroup = isNotifyEvent(r.event) ? NOTIFY_EVENTS[r.event].group : "problems";
  const step = r.text !== null && Object.hasOwn(STAGE_LABELS, r.text) ? STAGE_LABELS[r.text as keyof typeof STAGE_LABELS] : null;
  const detail = r.text === null || r.text === "" ? null : step ? `Step: ${step}` : r.text;
  const href = r.videoId === null ? null : group === "needs_you" ? `/queue?item=${encodeURIComponent(r.videoId)}` : `/videos/${r.videoId}`;
  return { group, title: r.title, detail, href, unread: r.readAt === null };
}
