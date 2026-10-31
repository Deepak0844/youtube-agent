import type pg from "pg";
import { canonicalJson, sha256Hex } from "@/server/core/content-hash";
import type { AskScene } from "@/server/core/scene-build";
import { failingScenes, repairSceneDoc, type SceneBody } from "@/server/core/scene-repair";
import { validateAndCheck } from "@/shared/scene/rules";
import { uuidv7 } from "@/server/core/ids";
import { recordAudit } from "./audit";
import { inTx, type EnqueueOnly } from "./pipeline";

// Scenes after Build: free re-check, paid repair of only the failing scenes, undo. Every change is a NEW `scenes` content
// version (never an edit), so history stays whole and a render built from older scenes becomes stale on its own (the render
// stage hashes the newest `scenes`). `meta` on the new row says what was changed or copied.

export interface SceneRow {
  id: string;
  version: number;
  body: SceneBody;
  meta: { changed?: string[]; copyOf?: number } | null;
}
export type Assets = (videoId: string) => Promise<string[]>;
export type Recheck = { ok: true; problems: [] } | { ok: false; problems: string[]; checkedVersion: number } | { ok: "none"; problems: string[] };

export async function currentScenes(db: pg.Pool, videoId: string): Promise<SceneRow | null> {
  const r = await db.query("select id, version, body, meta from video_content where video_id = $1 and kind = 'scenes' order by version desc limit 1", [videoId]);
  return r.rows[0] ?? null;
}

async function beatIds(db: pg.Pool, videoId: string): Promise<string[]> {
  const r = await db.query<{ body: { beats?: Array<{ id?: unknown }> } | null }>("select body from video_content where video_id = $1 and kind = 'beats' order by version desc limit 1", [videoId]);
  const beats = r.rows[0]?.body?.beats;
  return Array.isArray(beats) ? beats.map((b, i) => (typeof b?.id === "string" && b.id !== "" ? b.id : `beat-${i + 1}`)) : [];
}

async function checkOpts(db: pg.Pool, videoId: string, assets?: Assets) {
  const beats = await beatIds(db, videoId);
  return { beats: beats.length ? beats : undefined, assetIds: (await assets?.(videoId)) ?? [] };
}

/** Free: no model call, no spend. Runs the checks on the CURRENT scenes and leaves a log row. */
export async function recheckScenes(db: pg.Pool, videoId: string, assets?: Assets, sessionId?: string): Promise<Recheck> {
  const cur = await currentScenes(db, videoId);
  if (!cur) return { ok: "none", problems: ["There are no scenes for this video yet."] };
  const o = await checkOpts(db, videoId, assets);
  const r = validateAndCheck(cur.body, o);
  await recordAudit(db, "scenes.rechecked", { videoId, version: cur.version, problems: r.ok ? 0 : r.errors.length, sessionId });
  return r.ok ? { ok: true, problems: [] } : { ok: false, problems: r.errors, checkedVersion: cur.version };
}

async function appendVersion(db: pg.Pool, videoId: string, expectId: string, body: SceneBody, meta: object): Promise<number | null> {
  const c = await db.connect();
  try {
    await c.query("begin");
    await c.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`video_content:${videoId}:scenes`]);
    const cur = await c.query<{ id: string }>("select id from video_content where video_id = $1 and kind = 'scenes' order by version desc limit 1", [videoId]);
    if (cur.rows[0]?.id !== expectId) {
      await c.query("rollback");
      return null; // the scenes changed while the model worked: keep the newer one
    }
    const ins = await c.query<{ version: number }>(
      `insert into video_content (video_id, kind, version, sha256, body, meta)
       values ($1, 'scenes', (select coalesce(max(version), 0) + 1 from video_content where video_id = $1 and kind = 'scenes'), $2, $3, $4) returning version`,
      [videoId, sha256Hex(canonicalJson(body)), JSON.stringify(body), JSON.stringify(meta)],
    );
    await c.query("commit");
    return ins.rows[0]!.version;
  } catch (e) {
    await c.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

export type Repair = { ok: true; version: number; changed: string[] } | { ok: false; message: string };

/**
 * Paid. `ask` must be the reserved paid-call path (ctx.paid via the LLM client): a refusal or unclear outcome throws out of
 * here untouched so the stage parks; it is never retried. Only a document that passes EVERY check is saved.
 */
export async function repairScenes(db: pg.Pool, videoId: string, ask: AskScene, opts: { sceneIds?: string[]; assets?: Assets; sessionId?: string } = {}): Promise<Repair> {
  const cur = await currentScenes(db, videoId);
  if (!cur) return { ok: false, message: "There are no scenes to repair." };
  const o = await checkOpts(db, videoId, opts.assets);
  const check = validateAndCheck(cur.body, o);
  const problems = check.ok ? [] : check.errors;
  const { indexes, documentLevel } = failingScenes(problems);
  if (documentLevel) return { ok: false, message: `The problem is not in one scene, so it cannot be repaired scene by scene: ${problems.filter((p) => !p.startsWith("scene ")).slice(0, 3).join("; ")}` };
  let targets = indexes;
  if (opts.sceneIds) {
    const ids = cur.body.scenes.map((s) => s.id);
    const bad = opts.sceneIds.filter((id) => !ids.includes(id));
    if (bad.length) return { ok: false, message: `No scene with id ${bad.join(", ")}.` };
    targets = [...new Set([...indexes, ...opts.sceneIds.map((id) => ids.indexOf(id))])].sort((a, b) => a - b);
  }
  if (targets.length === 0) return { ok: false, message: "Every scene already passes the checks. Nothing to repair." };
  const res = await repairSceneDoc(cur.body, targets, problems, ask, { beats: o.beats, assets: o.assetIds });
  if (!res.ok) return { ok: false, message: `The scenes could not be repaired; the current version is unchanged. Last problems: ${res.errors.join("; ")}`.slice(0, 600) };
  const version = await appendVersion(db, videoId, cur.id, res.body, { changed: res.changed, from: cur.version });
  if (version === null) return { ok: false, message: "The scenes changed while the repair ran. Nothing was saved." };
  await recordAudit(db, "scenes.repaired", { videoId, from: cur.version, version, changed: res.changed, sessionId: opts.sessionId });
  return { ok: true, version, changed: res.changed };
}

export type Undo = { ok: true; version: number; restored: number } | { ok: false; message: string };

/**
 * Free. Appends a copy of the previous version as the newest one (history is never touched). An undo copy remembers which
 * version it copied, so pressing Undo again steps back one more from there rather than flipping back and forth.
 */
export async function undoScenes(db: pg.Pool, videoId: string, sessionId?: string): Promise<Undo> {
  const cur = await currentScenes(db, videoId);
  if (!cur) return { ok: false, message: "There are no scenes yet." };
  const pos = cur.meta?.copyOf ?? cur.version;
  const prev = await db.query<{ version: number; body: SceneBody }>("select version, body from video_content where video_id = $1 and kind = 'scenes' and version < $2 order by version desc limit 1", [videoId, pos]);
  const p = prev.rows[0];
  if (!p) return { ok: false, message: "There is no earlier version of the scenes to go back to." };
  const version = await appendVersion(db, videoId, cur.id, p.body, { copyOf: p.version, undoneFrom: cur.version });
  if (version === null) return { ok: false, message: "The scenes changed while you were looking. Look again." };
  await recordAudit(db, "scenes.undone", { videoId, restored: p.version, version, sessionId });
  return { ok: true, version, restored: p.version };
}

export type RepairRequest = { ok: true; stageRunId: string } | { ok: false; message: string };

/**
 * Owner asked for a repair. Free to call: it only queues the `repair_scenes` stage (the worker pays, inside ctx.paid, against
 * the video's budget scopes). Refused when the video is not live, scenes do not exist, or a repair is already queued/running.
 */
export async function requestSceneRepair(db: pg.Pool, queue: EnqueueOnly, videoId: string, sceneIds?: string[], sessionId?: string): Promise<RepairRequest> {
  const out = await inTx(db, async (c): Promise<RepairRequest & { hash?: string }> => {
    const v = await c.query<{ status: string }>("select status from videos where id = $1 for update", [videoId]);
    if (!v.rows[0]) return { ok: false, message: "That video was not found." };
    if (v.rows[0].status !== "active" && v.rows[0].status !== "waiting") return { ok: false, message: "This video is no longer in production." };
    const sc = await c.query<{ sha256: string }>("select sha256 from video_content where video_id = $1 and kind = 'scenes' order by version desc limit 1", [videoId]);
    if (!sc.rows[0]) return { ok: false, message: "There are no scenes to repair yet." };
    const busy = await c.query("select 1 from stage_runs where video_id = $1 and name = 'repair_scenes' and status in ('queued', 'running', 'needs_decision')", [videoId]);
    if (busy.rowCount) return { ok: false, message: "A repair is already queued or running for this video." };
    const hash = sha256Hex(canonicalJson({ stage: "repair_scenes", scenes: sc.rows[0].sha256, sceneIds: sceneIds ?? null }));
    const id = uuidv7();
    const ins = await c.query("insert into stage_runs (id, video_id, name, status, input_hash, result) values ($1, $2, 'repair_scenes', 'queued', $3, $4) on conflict do nothing", [id, videoId, hash, JSON.stringify({ request: { sceneIds: sceneIds ?? null } })]);
    if (!ins.rowCount) return { ok: false, message: "These scenes were already repaired. Re-check them first." };
    return { ok: true, stageRunId: id, hash };
  });
  if (!out.ok) return out;
  await recordAudit(db, "scenes.repair_requested", { videoId, stageRunId: out.stageRunId, sceneIds: sceneIds ?? null, sessionId });
  // After the commit. If Redis is down the row stays queued and the reconciler enqueues it.
  await queue.enqueue(out.stageRunId, 0, 0, out.hash!).catch(() => undefined);
  return { ok: true, stageRunId: out.stageRunId };
}
