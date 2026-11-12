// Queue inbox (UI redesign spec §4.3, layout F): a list on the left, the selected item on the right. The selection and
// the tab live in the URL (?item=<videoId>&tab=needs|running|failed) so back, refresh and live updates keep them.

export type QueueTab = "needs" | "running" | "failed";

export function parseQueueTab(v: unknown): QueueTab {
  return v === "running" || v === "failed" ? v : "needs";
}

/**
 * The item named in the URL. With no item named, the oldest one (the list is oldest first). An item that is no longer
 * waiting gives null: the pane must never put another video's approve button where the one just used was.
 */
export function pickItem<T extends { videoId: string }>(items: readonly T[], wanted: string | undefined): T | null {
  if (wanted) return items.find((i) => i.videoId === wanted) ?? null;
  return items[0] ?? null;
}
