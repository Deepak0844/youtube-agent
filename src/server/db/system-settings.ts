import { createHash } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import { redactDetail } from "@/server/core/audit-events";
import { ownServicePorts, parseLocalServicesInput, validateLocalService } from "@/server/core/local-services";
import { getSetting, setSessionSettings } from "@/server/db/settings";
import { recordAudit } from "@/server/db/audit";

// Writers behind /settings/system. Callers (server actions) have already done requireOwner(). There is no actor argument:
// everything here is written through setSessionSettings, which can only write as a logged-in session (safety keys such as
// the local-service list require that). Every change is audited with old and new values in the SAME transaction as the
// write, so a failed audit saves nothing. Nothing here is secret. Errors returned to the page are fixed sentences.

const GENERIC = "That could not be saved. Check the values and try again.";

// Plain decimal integers only, as number or string: no exponent, hex, sign, padding, leading zeros or decimals.
const int = (max: number) =>
  z
    .union([z.number().int(), z.string().regex(/^[1-9][0-9]{0,6}$/).transform(Number)])
    .pipe(z.number().int().min(1).max(max));
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

// The audit redactor blanks any 32+ character run of URL-safe characters (a host label can be that long). An entry that
// would be blanked is recorded as a short hash, so the row still tells entries apart without storing a secret-looking string.
function auditEntry(entry: string): string {
  if (redactDetail({ v: entry }).redacted.length === 0) return entry;
  return `sha256:${createHash("sha256").update(entry).digest("hex").slice(0, 16)}`;
}
const auditValue = (key: string, v: unknown): unknown => (key === "network.local_services" && Array.isArray(v) ? v.map((e) => auditEntry(String(e))) : v);

async function writeAudited(db: pg.Pool, writes: Array<{ key: string; value: unknown }>): Promise<string[]> {
  const changed: string[] = [];
  await setSessionSettings(db, writes, async (client, key, c) => {
    if (canonical(c.old) === canonical(c.new)) return;
    await recordAudit(client, "setting.changed", { setting: key, from: auditValue(key, c.old), to: auditValue(key, c.new) });
    changed.push(key);
  });
  return changed;
}

export async function saveSystemSettings(db: pg.Pool, input: unknown): Promise<SaveResult> {
  const p = systemFormSchema.safeParse(input);
  if (!p.success) return { ok: false, error: "Check the numbers: whole numbers only, within the allowed range." };
  const v = p.data;
  try {
    const changed = await writeAudited(db, [
      { key: "jobs.concurrent_renders", value: v.concurrent_renders },
      { key: "jobs.concurrent_jobs", value: v.concurrent_jobs },
      { key: "storage.warn_gb", value: v.storage_warn_gb },
      { key: "video.max_long_minutes", value: v.max_long_minutes },
      // read under the lock, so other tracks are never overwritten with a stale copy
      { key: "tracks.enabled", value: (cur: unknown) => ({ ...(cur as Record<string, boolean>), scene_kit: v.scene_kit }) },
    ]);
    return { ok: true, changed };
  } catch {
    return { ok: false, error: GENERIC };
  }
}

const MB = 1024 ** 2;
const GB = 1024 ** 3;

// /settings/assets: same rules as above. The page shows sizes in MB / GB / megapixels; they are stored as bytes and pixels.

export const assetFormSchema = z
  .object({
    retention_days: int(60),
    unused_days: int(365),
    trash_days: int(60),
    max_image_mb: int(1024),
    max_audio_mb: int(4096),
    max_megapixels: int(500),
    max_batch_files: int(1000),
    total_gb: int(1000),
  })
  .strict();

export async function saveAssetSettings(db: pg.Pool, input: unknown): Promise<SaveResult> {
  const p = assetFormSchema.safeParse(input);
  if (!p.success) return { ok: false, error: "Check the numbers: whole numbers only, within the allowed range." };
  const v = p.data;
  try {
    const changed = await writeAudited(db, [
      { key: "assets.retention_days", value: v.retention_days },
      { key: "assets.unused_days", value: v.unused_days },
      { key: "assets.trash_days", value: v.trash_days },
      { key: "assets.max_image_bytes", value: v.max_image_mb * MB },
      { key: "assets.max_audio_bytes", value: v.max_audio_mb * MB },
      { key: "assets.max_pixels", value: v.max_megapixels * 1_000_000 },
      { key: "assets.max_batch_files", value: v.max_batch_files },
      { key: "assets.total_bytes_cap", value: v.total_gb * GB },
    ]);
    return { ok: true, changed };
  } catch {
    return { ok: false, error: GENERIC };
  }
}

type Env = Record<string, string | undefined>;

/** Saves the allow-list from textarea text. All-or-nothing: one bad line saves nothing. */
export async function saveLocalServices(db: pg.Pool, text: string, opts: { ownPorts?: ReadonlySet<number>; env?: Env } = {}): Promise<SaveResult> {
  let parsed;
  try {
    parsed = parseLocalServicesInput(text, opts.ownPorts ?? ownServicePorts(opts.env), opts.env);
  } catch {
    return { ok: false, error: "Own-service settings on the server are unreadable, so nothing can be listed right now." };
  }
  if (!parsed.ok) return { ok: false, error: "Some lines were refused. Nothing was saved.", lines: parsed.errors };
  try {
    const changed = await writeAudited(db, [{ key: "network.local_services", value: parsed.entries }]);
    return { ok: true, changed: changed.length > 0 };
  } catch {
    return { ok: false, error: GENERIC };
  }
}

/** The stored list, minus anything that would not pass today's validation (a hand-edited row is never trusted). */
export async function loadLocalServices(db: pg.Pool, ownPorts?: ReadonlySet<number>, env?: Env): Promise<string[]> {
  const raw = await getSetting(db, "network.local_services");
  if (!Array.isArray(raw)) return [];
  let ports: ReadonlySet<number>;
  try {
    ports = ownPorts ?? ownServicePorts(env);
  } catch {
    return []; // fail closed: show nothing rather than a list that cannot be checked
  }
  const out: string[] = [];
  for (const item of raw) {
    // `blockers` only matter for saving and fetching; the page still shows what is stored, with its own notice
    const r = validateLocalService(item as string, ports, { ...(env ?? process.env), NODE_ENV: "development" });
    if (r.ok && r.entry === item && !out.includes(r.entry)) out.push(r.entry);
  }
  return out;
}

export interface SystemSettingsView {
  renders: number;
  jobs: number;
  warnGb: number;
  longMinutes: number;
  sceneKit: boolean;
  services: string[];
}

/** Everything the page shows, read here so only this file touches the settings module. */
export async function loadSystemSettings(db: pg.Pool): Promise<SystemSettingsView> {
  const [renders, jobs, warnGb, longMinutes, tracks, services] = await Promise.all([
    getSetting(db, "jobs.concurrent_renders") as Promise<number>,
    getSetting(db, "jobs.concurrent_jobs") as Promise<number>,
    getSetting(db, "storage.warn_gb") as Promise<number>,
    getSetting(db, "video.max_long_minutes") as Promise<number>,
    getSetting(db, "tracks.enabled") as Promise<{ scene_kit: boolean }>,
    loadLocalServices(db),
  ]);
  return { renders, jobs, warnGb, longMinutes, sceneKit: tracks.scene_kit, services };
}
