import type pg from "pg";
import { listIdeas, type IdeaRow } from "@/server/db/ideas";
import { budgetLeftMicro, waitingForOwner } from "@/server/db/drafting";
import { recentRuns, type ScheduleRunRow } from "@/server/db/scheduler";
import { loadInrRate, loadScheduler } from "@/server/db/system-settings";
import type { SchedulerSettings } from "@/server/core/scheduler";

// Read only data for /calendar. Nothing here writes.
export interface UploadLine {
  videoId: string;
  topic: string;
  status: string;
  at: Date | null;
}

export interface CalendarData {
  settings: SchedulerSettings;
  runs: ScheduleRunRow[]; // newest first, about 15
  lastDrafting: ScheduleRunRow | null;
  waiting: number;
  budgetLeftMicro: number | null;
  rate: number;
  ideas: IdeaRow[]; // top 10 proposed by score
  queue: UploadLine[];
  uploaded: UploadLine[];
}

async function uploadLines(db: pg.Pool, statuses: string[], limit: number): Promise<UploadLine[]> {
  const { rows } = await db.query<{ video_id: string; topic: string; status: string; at: Date | null }>(
    `select u.video_id, v.topic, u.status, coalesce(u.finished_at, u.started_at) as at
       from uploads u join videos v on v.id = u.video_id
      where u.status = any($1) order by coalesce(u.finished_at, u.started_at) desc nulls first limit $2`,
    [statuses, limit],
  );
  return rows.map((r) => ({ videoId: r.video_id, topic: r.topic, status: r.status, at: r.at }));
}

export async function loadCalendar(db: pg.Pool): Promise<CalendarData> {
  const [settings, runs, waiting, left, rate, ideas, queue, uploaded] = await Promise.all([
    loadScheduler(db),
    recentRuns(db, 30),
    waitingForOwner(db),
    budgetLeftMicro(db),
    loadInrRate(db),
    listIdeas(db),
    uploadLines(db, ["publish_approved", "uploading", "upload_failed"], 20),
    uploadLines(db, ["uploaded"], 20),
  ]);
  return {
    settings,
    runs: runs.slice(0, 15),
    lastDrafting: runs.find((r) => r.job === "drafting") ?? null,
    waiting,
    budgetLeftMicro: left,
    rate,
    ideas: ideas.filter((i) => i.status === "proposed").slice(0, 10),
    queue,
    uploaded,
  };
}
