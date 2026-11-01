"use server";

import { refresh } from "next/cache";
import { assertActionOrigin } from "@/lib/auth/action-origin";
import { requireOwner } from "@/lib/auth/require-owner";
import { getPool } from "@/server/db/pool";
import { webStageQueue } from "@/server/queue/web-queues";
import { requestSceneRepair, recheckScenes, undoScenes } from "@/server/db/scene-repair";

// Free scene actions (no model call, no money): requireOwner() first, then the Origin check, then the id is shape-checked.
// Repair is paid, so it never runs here: requestSceneRepairAction only queues the `repair_scenes` stage, and the worker pays under ctx.paid.
export type SceneActionState = { ok: boolean; message: string; problems?: string[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bad = (message: string): SceneActionState => ({ ok: false, message });

export async function recheckScenesAction(videoId: string): Promise<SceneActionState> {
  const owner = await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return bad(origin);
  if (typeof videoId !== "string" || !UUID.test(videoId)) return bad("That video was not found.");
  const r = await recheckScenes(getPool(), videoId, undefined, owner.sessionId);
  if (r.ok === "none") return bad(r.problems[0]!);
  return r.ok ? { ok: true, message: "The scenes pass every check.", problems: [] } : { ok: false, message: `${r.problems.length} problem(s) found.`, problems: r.problems.slice(0, 20) };
}

export async function undoScenesAction(videoId: string): Promise<SceneActionState> {
  const owner = await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return bad(origin);
  if (typeof videoId !== "string" || !UUID.test(videoId)) return bad("That video was not found.");
  const r = await undoScenes(getPool(), videoId, owner.sessionId);
  refresh();
  return r.ok ? { ok: true, message: `Went back to version ${r.restored} of the scenes.` } : bad(r.message);
}

export async function requestSceneRepairAction(videoId: string, sceneIds?: string[]): Promise<SceneActionState> {
  const owner = await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return bad(origin);
  if (typeof videoId !== "string" || !UUID.test(videoId)) return bad("That video was not found.");
  if (sceneIds !== undefined && (!Array.isArray(sceneIds) || sceneIds.length > 50 || sceneIds.some((s) => typeof s !== "string" || s === "" || s.length > 64))) return bad("Those scenes were not recognised.");
  const r = await requestSceneRepair(getPool(), webStageQueue(), videoId, sceneIds, owner.sessionId);
  refresh();
  return r.ok ? { ok: true, message: "Repair queued: it asks the model to fix only the scenes that failed; untouched scenes stay as they are." } : bad(r.message);
}
