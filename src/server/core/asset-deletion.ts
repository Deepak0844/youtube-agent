// When an uploaded asset will be cleaned up automatically (Doc 13 4). Pure: the cleanup job itself arrives with publishing
// (Phase 5), because "finished" needs the upload result. Keep and series pins are never deleted.
const DAY = 86_400_000;
const after = (d: Date, days: number) => new Date(d.getTime() + days * DAY);

export interface DeletionInput {
  finishedAt: Date | null;
  keep: boolean;
  pinnedToSeries: boolean;
  retentionDays: number;
  createdAt: Date;
  usedByAnyVideo: boolean;
  unusedDays: number;
}

export function deletesOn(a: DeletionInput): Date | null {
  if (a.keep || a.pinnedToSeries) return null;
  if (!a.usedByAnyVideo) return after(a.createdAt, a.unusedDays);
  return a.finishedAt ? after(a.finishedAt, a.retentionDays) : null;
}
