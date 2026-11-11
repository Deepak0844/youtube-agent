// Queue inbox (UI redesign spec §4.3, layout F): a list on the left, the selected item on the right. The selection and
// the tab live in the URL (?item=<videoId>&tab=needs|running|failed) so back, refresh and live updates keep them.

export type QueueTab = "needs" | "running" | "failed";

export function parseQueueTab(v: unknown): QueueTab {
  return v === "running" || v === "failed" ? v : "needs";
}

/** The item named in the URL, else the oldest one (the list is oldest first); null when the list is empty. */
export function pickItem<T extends { videoId: string }>(items: readonly T[], wanted: string | undefined): T | null {
  return items.find((i) => i.videoId === wanted) ?? items[0] ?? null;
}
