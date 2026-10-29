"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { requireOwner } from "@/lib/auth/require-owner";
import { toCards, type AssetCard } from "@/server/db/asset-cards";
import { listAssets, restoreAsset, setKeep, tagAssets, trashAssets } from "@/server/db/assets";
import { recordAudit } from "@/server/db/audit";
import { getPool } from "@/server/db/pool";

// Session first, then zod, then one data-layer call and one audit row per change. Audit detail is ids and counts only.
export interface AssetActionResult {
  ok: boolean;
  message?: string;
  /** Delete only: these Keep assets were held back and need an explicit yes. */
  keptBlocked?: string[];
}

const ids = z.array(z.uuid()).min(1).max(200);
const tag = z.string().trim().min(1).max(60);

export async function setKeepAction(id: string, keep: boolean): Promise<AssetActionResult> {
  await requireOwner();
  const p = z.object({ id: z.uuid(), keep: z.boolean() }).safeParse({ id, keep });
  if (!p.success || !(await setKeep(getPool(), p.data.id, p.data.keep))) return { ok: false, message: "Could not change Keep." };
  await recordAudit(getPool(), "asset.kept", { assetId: p.data.id, keep: p.data.keep });
  refresh();
  return { ok: true };
}

export async function trashAction(assetIds: string[], confirmKeep: boolean): Promise<AssetActionResult> {
  await requireOwner();
  const p = z.object({ ids, confirmKeep: z.boolean() }).safeParse({ ids: assetIds, confirmKeep });
  if (!p.success) return { ok: false, message: "Nothing was deleted." };
  const r = await trashAssets(getPool(), p.data.ids, p.data.confirmKeep);
  if (r.trashed.length) await recordAudit(getPool(), "asset.deleted", { assetIds: r.trashed, count: r.trashed.length });
  refresh();
  return r.keptBlocked.length ? { ok: false, keptBlocked: r.keptBlocked } : { ok: true };
}

export async function restoreAction(id: string): Promise<AssetActionResult> {
  await requireOwner();
  const p = z.uuid().safeParse(id);
  if (!p.success || !(await restoreAsset(getPool(), p.data))) return { ok: false, message: "This file was already removed for good." };
  await recordAudit(getPool(), "asset.restored", { assetId: p.data });
  refresh();
  return { ok: true };
}

export async function tagAction(assetIds: string[], tags: string[]): Promise<AssetActionResult> {
  await requireOwner();
  const p = z.object({ ids, tags: z.array(tag).min(1).max(20) }).safeParse({ ids: assetIds, tags });
  if (!p.success) return { ok: false, message: "Enter a tag of up to 60 characters." };
  const done = await tagAssets(getPool(), p.data.ids, p.data.tags);
  if (done.length) await recordAudit(getPool(), "asset.tagged", { assetIds: done, count: done.length, tagCount: p.data.tags.length });
  refresh();
  return { ok: true };
}

/** For the picker: newest first when `q` is empty ("recent"). */
export async function searchAssetsAction(kind: "image" | "audio" | undefined, q: string): Promise<AssetCard[]> {
  await requireOwner();
  const p = z.object({ kind: z.enum(["image", "audio"]).optional(), q: z.string().max(100) }).safeParse({ kind, q });
  if (!p.success) return [];
  return toCards(getPool(), await listAssets(getPool(), { kind: p.data.kind, q: p.data.q || undefined }, 30));
}
