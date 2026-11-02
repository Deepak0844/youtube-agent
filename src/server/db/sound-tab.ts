import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type pg from "pg";
import { SfxPlan } from "@/server/core/sfx-plan";
import { BedChoice, bedChoiceHash, cueRows, DEFAULT_BED_GAIN_DB, parseVerdicts, withBedChoice, type CueRow, type Verdict } from "@/server/core/sound-view";
import { mediaSigner } from "@/server/db/queue-data";
import { safeJoin, storageRoot } from "@/server/storage/paths";

// Everything the Sound tab shows, and the bed-choice file it writes (videos/<id>/sound-bed.json, read by the Sound step).

export interface BedOption { id: string; name: string; tags: string[]; durationS: number | null; src: string | null }
export interface SoundTab {
  rows: CueRow[];
  beds: BedOption[];
  chosen: string | null;
  /** a bed is chosen and the last Sound run was made with a different one (or none yet): re-run it */
  stale: boolean;
  /** null until the Sound step has finished once with this feature */
  verdicts: Verdict[] | null;
  /** the owner ticked "sound is OK" for the current Sound run */
  earOk: boolean;
}

const readJson = async (rel: string[]): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(await safeJoin(storageRoot(), ...rel), "utf8"));
  } catch {
    return null;
  }
};

export async function readBedChoice(videoId: string): Promise<BedChoice | null> {
  const r = BedChoice.safeParse(await readJson(["videos", videoId, "sound-bed.json"]));
  return r.success ? r.data : null;
}

/** Saves the choice (item null = no owner bed). The item must be a music item in the library. Returns false when it is not. */
export async function saveBedChoice(db: pg.Pool, videoId: string, item: string | null): Promise<boolean> {
  const file = await safeJoin(storageRoot(), "videos", videoId, "sound-bed.json");
  if (item === null) {
    await rm(file, { force: true });
    return true;
  }
  const ok = await db.query("select 1 from audio_items where kind = 'music' and id::text = $1", [item]);
  if (!ok.rowCount) return false;
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify({ item, gainDb: DEFAULT_BED_GAIN_DB, loop: true }));
  await rename(tmp, file);
  return true;
}

export async function loadSoundTab(db: pg.Pool, videoId: string): Promise<SoundTab> {
  const parsed = SfxPlan.safeParse(await readJson(["videos", videoId, "sfx-plan.json"]));
  const choice = await readBedChoice(videoId);
  const plan = withBedChoice(parsed.success ? parsed.data : { version: 1, cues: [] }, choice);
  const ids = [...new Set([...plan.cues.map((c) => c.itemId), ...(plan.bed ? [plan.bed.item] : [])])];
  const named = await db.query<{ id: string; name: string }>("select id, name from audio_items where id::text = any($1::text[])", [ids]);
  const sign = await mediaSigner(db);
  const music = await db.query<{ id: string; name: string; tags: string[]; duration_s: string | null; file_path: string }>(
    "select id, name, tags, duration_s, file_path from audio_items where kind = 'music' order by name, id",
  );
  const run = (await db.query<{ id: string; result: unknown }>("select id, result from stage_runs where video_id = $1 and name = 'sfx' and status = 'succeeded' order by created_at desc, id desc limit 1", [videoId])).rows[0];
  const res = (typeof run?.result === "object" && run.result !== null ? run.result : {}) as Record<string, unknown>;
  const ear = run ? (await db.query("select 1 from audit_log where event = 'sound.ear_ok' and detail->>'videoId' = $1 and detail->>'stageRunId' = $2 limit 1", [videoId, run.id])).rowCount : 0;
  return {
    rows: cueRows(plan, new Map(named.rows.map((r) => [r.id, r.name]))),
    beds: music.rows.map((m) => ({ id: m.id, name: m.name, tags: m.tags, durationS: m.duration_s === null ? null : Number(m.duration_s), src: sign?.(`audio/${m.file_path}`) ?? null })),
    chosen: choice?.item ?? null,
    stale: choice !== null && res.bedHash !== bedChoiceHash(choice),
    verdicts: run && "audibility" in res ? parseVerdicts(res.audibility) : null,
    earOk: (ear ?? 0) > 0,
  };
}

/** The newest succeeded Sound run of the video, or null. */
export async function latestSoundRunId(db: pg.Pool, videoId: string): Promise<string | null> {
  const r = await db.query<{ id: string }>("select id from stage_runs where video_id = $1 and name = 'sfx' and status = 'succeeded' order by created_at desc, id desc limit 1", [videoId]);
  return r.rows[0]?.id ?? null;
}
