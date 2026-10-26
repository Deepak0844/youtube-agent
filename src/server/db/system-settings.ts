import type pg from "pg";
import { z } from "zod";
import { ownServicePorts, parseLocalServicesInput, validateLocalService } from "@/server/core/local-services";
import { getSetting, setSetting, type Actor } from "@/server/db/settings";
import { recordAudit } from "@/server/db/audit";

// Writers behind /settings/system. Callers (server actions) have already done requireOwner(); the actor is still passed
// down so a safety key can never be written by anything but a session (settings.ts enforces it). Every change is audited
// with old and new values, in the same transaction as the write; nothing here is secret. Errors returned to the page
// are fixed sentences.

const GENERIC = "That could not be saved. Check the values and try again.";

const int = (max: number) => z.coerce.number().int().min(1).max(max);
export const systemFormSchema = z
  .object({
    concurrent_renders: int(8),
    concurrent_jobs: int(16),
    storage_warn_gb: int(100_000),
    max_long_minutes: int(240),
    scene_kit: z.boolean(),
  })
  .strict();

export type SaveResult =
  | { ok: true; changed: boolean | string[] }
  | { ok: false; error: string; lines?: Array<{ line: number; reason: string }> };

// jsonb returns object keys in its own order, so compare with keys sorted.
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

// The audit row is written in the same transaction as the value; an unchanged value writes no audit row.
async function change(db: pg.Pool, key: string, value: unknown, actor: Actor): Promise<boolean> {
  let changed = false;
  await setSetting(db, key, value, {
    actor,
    inTx: async (client, c) => {
      if (canonical(c.old) === canonical(c.new)) return;
      await recordAudit(client, "setting.changed", { setting: key, from: c.old, to: c.new });
      changed = true;
    },
  });
  return changed;
}

export async function saveSystemSettings(db: pg.Pool, input: unknown, actor: Actor = "session"): Promise<SaveResult> {
  const p = systemFormSchema.safeParse(input);
  if (!p.success) return { ok: false, error: "Check the numbers: whole numbers only, within the allowed range." };
  const v = p.data;
  try {
    const changed: string[] = [];
    const tracks = (await getSetting(db, "tracks.enabled")) as Record<string, boolean>;
    const writes: Array<[string, unknown]> = [
      ["jobs.concurrent_renders", v.concurrent_renders],
      ["jobs.concurrent_jobs", v.concurrent_jobs],
      ["storage.warn_gb", v.storage_warn_gb],
      ["video.max_long_minutes", v.max_long_minutes],
      ["tracks.enabled", { ...tracks, scene_kit: v.scene_kit }],
    ];
    for (const [key, value] of writes) if (await change(db, key, value, actor)) changed.push(key);
    return { ok: true, changed };
  } catch {
    return { ok: false, error: GENERIC };
  }
}

/** Saves the allow-list from textarea text. All-or-nothing: one bad line saves nothing. */
export async function saveLocalServices(
  db: pg.Pool,
  text: string,
  opts: { actor?: Actor; ownPorts?: ReadonlySet<number> } = {},
): Promise<SaveResult> {
  const parsed = parseLocalServicesInput(text, opts.ownPorts ?? ownServicePorts());
  if (!parsed.ok) return { ok: false, error: "Some lines were refused. Nothing was saved.", lines: parsed.errors };
  try {
    return { ok: true, changed: await change(db, "network.local_services", parsed.entries, opts.actor ?? "session") };
  } catch {
    return { ok: false, error: GENERIC };
  }
}

/** The stored list, minus anything that would not pass today's validation (a hand-edited row is never trusted). */
export async function loadLocalServices(db: pg.Pool, ownPorts: ReadonlySet<number> = ownServicePorts()): Promise<string[]> {
  const raw = await getSetting(db, "network.local_services");
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    const r = validateLocalService(item as string, ownPorts);
    if (r.ok && r.entry === item && !out.includes(r.entry)) out.push(r.entry);
  }
  return out;
}
