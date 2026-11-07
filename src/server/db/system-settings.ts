import { createHash } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import { LIVE_PHRASE } from "@/server/core/comments";
import { CUTOVER_PHRASE } from "@/server/core/channel-safety";
import { DEFAULT_INR_RATE } from "@/server/core/display-format";
import { redactDetail } from "@/server/core/audit-events";
import { ownServicePorts, parseLocalServicesInput, validateLocalService } from "@/server/core/local-services";
import { SCHEDULER_DEFAULTS, schedulerSchema, type SchedulerSettings } from "@/server/core/scheduler";
import { SETTINGS } from "@/server/core/settings-registry";
import { secretName, type ProviderId } from "@/server/core/provider-keys";
import { ENGINE_KEYS } from "@/server/core/engine-config";
import { ENGINE_NUMBER_KEYS, ENGINE_NUMBER_FIELDS, parseEngineNumbers } from "@/server/core/engine-numbers";
import { getSetting, getStoredSettings, setSessionSettings } from "@/server/db/settings";
import { recordAudit } from "@/server/db/audit";
import { hasSecret } from "@/server/db/vault";
import { checkVoiceField, VOICE_FIELDS, isVoiceField } from "@/server/providers/voice/endpoints";

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
    render_timeout_s: int(3600).pipe(z.number().min(60)),
    native_3d: z.boolean(),
    native_timeout_s: int(7200).pipe(z.number().min(60)),
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
      { key: "render.timeout_s", value: v.render_timeout_s },
      { key: "render.native_3d", value: v.native_3d },
      { key: "render.native_timeout_s", value: v.native_timeout_s },
      // read under the lock, so other tracks are never overwritten with a stale copy
      { key: "tracks.enabled", value: (cur: unknown) => ({ ...(cur as Record<string, boolean>), scene_kit: v.scene_kit }) },
    ]);
    return { ok: true, changed };
  } catch {
    return { ok: false, error: GENERIC };
  }
}

/** The two global upload switches. Turning the kill switch ON or the cutover OFF needs nothing more; turning the cutover ON needs the typed phrase. */
export async function saveUploadSwitches(db: pg.Pool, input: { killSwitch?: boolean; cutover?: boolean; typed?: string; commentsDryRun?: boolean; typedLive?: string }): Promise<SaveResult> {
  const writes: Array<{ key: string; value: unknown }> = [];
  // Comment replies: dry run is the default; false lets the owner's "Approve and post" really post. Session only, audited as setting.changed.
  if (input.commentsDryRun === false && input.typedLive !== LIVE_PHRASE) return { ok: false, error: `Type ${LIVE_PHRASE} exactly to turn dry run off. Nothing was saved.` };
  if (typeof input.commentsDryRun === "boolean") writes.push({ key: "comments.dry_run", value: input.commentsDryRun });
  if (typeof input.killSwitch === "boolean") writes.push({ key: "uploads.kill_switch", value: input.killSwitch });
  if (typeof input.cutover === "boolean") {
    if (input.cutover && input.typed !== CUTOVER_PHRASE) return { ok: false, error: `Type ${CUTOVER_PHRASE} exactly to confirm. Nothing was saved.` };
    writes.push({ key: "youtube.cutover_done", value: input.cutover });
  }
  if (writes.length === 0) return { ok: false, error: GENERIC };
  try {
    return { ok: true, changed: await writeAudited(db, writes) };
  } catch {
    return { ok: false, error: GENERIC };
  }
}

/** The saved rupee rate; a hand-edited bad value falls back to the default. */
export async function loadInrRate(db: pg.Pool): Promise<number> {
  const v = await getSetting(db, "display.inr_rate");
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : DEFAULT_INR_RATE;
}

/** Saves the rupees-per-dollar rate used for display only. Text must be a plain positive decimal. */
export async function saveInrRate(db: pg.Pool, raw: unknown): Promise<SaveResult> {
  const bad = { ok: false, error: "Enter a rate above 0, such as 95.05." } as const;
  if (typeof raw !== "string" || !/^\d{1,5}(\.\d{1,4})?$/.test(raw.trim())) return bad;
  const rate = Number(raw.trim());
  if (!(rate > 0) || rate > 10_000) return bad;
  try {
    return { ok: true, changed: await writeAudited(db, [{ key: "display.inr_rate", value: rate }]) };
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
export async function saveLocalServices(
  db: pg.Pool,
  text: string,
  opts: { ownPorts?: ReadonlySet<number>; env?: Env; confirmed?: boolean } = {},
): Promise<SaveResult> {
  let parsed;
  try {
    parsed = parseLocalServicesInput(text, opts.ownPorts ?? ownServicePorts(opts.env), opts.env);
  } catch {
    return { ok: false, error: "Own-service settings on the server are unreadable, so nothing can be listed right now." };
  }
  if (!parsed.ok) return { ok: false, error: "Some lines were refused. Nothing was saved.", lines: parsed.errors };
  // Widening the list widens what the app may call, so adding an entry needs the owner's explicit confirmation (removing does not).
  const stored = await loadLocalServices(db, opts.ownPorts ?? ownServicePorts(opts.env), opts.env);
  if (!opts.confirmed && parsed.entries.some((e) => !stored.includes(e))) {
    return { ok: false, error: "Tick the box to confirm the app may call the new address. Nothing was saved." };
  }
  try {
    const changed = await writeAudited(db, [{ key: "network.local_services", value: parsed.entries }]);
    return { ok: true, changed: changed.length > 0 };
  } catch {
    return { ok: false, error: GENERIC };
  }
}

/** Saves one voice server setting (address or region), checked with the voice stage's own rules. Empty clears it. */
export async function saveVoiceServer(db: pg.Pool, field: unknown, raw: unknown): Promise<SaveResult> {
  if (!isVoiceField(field) || typeof raw !== "string") return { ok: false, error: GENERIC };
  const def = VOICE_FIELDS[field];
  try {
    const hasKey = def.slot ? await hasSecret(db, secretName(def.slot as ProviderId)) : false;
    const c = checkVoiceField(field, raw, hasKey);
    if (!c.ok) return { ok: false, error: c.error };
    const changed = await writeAudited(db, [{ key: def.key, value: c.value }]);
    return { ok: true, changed: changed.length > 0 };
  } catch {
    return { ok: false, error: GENERIC };
  }
}

/** The three voice server values as stored (not secret). */
export async function loadVoiceServers(db: pg.Pool): Promise<Record<keyof typeof VOICE_FIELDS, string>> {
  const [voicestudio_url, local_url, azure_region] = await Promise.all(
    (Object.values(VOICE_FIELDS)).map(async (d) => String(await getSetting(db, d.key))),
  );
  return { voicestudio_url: voicestudio_url!, local_url: local_url!, azure_region: azure_region! };
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
  renderTimeoutS: number;
  native3d: boolean;
  nativeTimeoutS: number;
  sceneKit: boolean;
  services: string[];
  killSwitch: boolean;
  cutoverDone: boolean;
}

/** Everything the page shows, read here so only this file touches the settings module. */
export async function loadSystemSettings(db: pg.Pool): Promise<SystemSettingsView> {
  const [renders, jobs, warnGb, longMinutes, renderTimeoutS, native3d, nativeTimeoutS, tracks, services, killSwitch, cutoverDone] = await Promise.all([
    getSetting(db, "jobs.concurrent_renders") as Promise<number>,
    getSetting(db, "jobs.concurrent_jobs") as Promise<number>,
    getSetting(db, "storage.warn_gb") as Promise<number>,
    getSetting(db, "video.max_long_minutes") as Promise<number>,
    getSetting(db, "render.timeout_s") as Promise<number>,
    getSetting(db, "render.native_3d") as Promise<boolean>,
    getSetting(db, "render.native_timeout_s") as Promise<number>,
    getSetting(db, "tracks.enabled") as Promise<{ scene_kit: boolean }>,
    loadLocalServices(db),
    getSetting(db, "uploads.kill_switch"),
    getSetting(db, "youtube.cutover_done"),
  ]);
  return { renders, jobs, warnGb, longMinutes, renderTimeoutS, native3d: native3d === true, nativeTimeoutS, sceneKit: tracks.scene_kit, services, killSwitch: killSwitch !== false, cutoverDone: cutoverDone === true };
}

/** Engine numbers form: the stored value of each field (default when no row), as the text the form shows. */
export async function loadEngineNumbers(db: pg.Pool): Promise<Record<string, unknown>> {
  const stored = await getStoredSettings(db, ENGINE_NUMBER_KEYS);
  return Object.fromEntries(ENGINE_NUMBER_FIELDS.map((f) => [f.key, stored.has(f.key) ? stored.get(f.key) : SETTINGS[f.key].default]));
}

/** input: setting key -> text. Range-checked by the registry, cross-checked like the engine, audited as setting.changed. */
export async function saveEngineNumbers(db: pg.Pool, input: Record<string, unknown>): Promise<SaveResult> {
  const p = parseEngineNumbers(input, await getStoredSettings(db, ENGINE_KEYS));
  if (!p.ok) return { ok: false, error: `${p.error} Nothing was saved.` };
  try {
    return { ok: true, changed: await writeAudited(db, p.values) };
  } catch {
    return { ok: false, error: GENERIC };
  }
}

/**
 * Saves /settings/schedule. Turning overnight drafting ON (it was off) needs the owner's explicit "I understand it spends money"
 * confirmation; the form sends it as `confirmSpend`. Everything else in the file is already validated by the schema.
 */
export async function saveSchedulerSettings(db: pg.Pool, input: unknown, confirmSpend: boolean): Promise<SaveResult> {
  const p = schedulerSchema.safeParse(input);
  if (!p.success) return { ok: false, error: "Check the values: hours are 0 to 23, drafts per night 0 to 5, waiting drafts 1 to 10." };
  try {
    let refused = false;
    const changed = await writeAudited(db, [
      {
        key: "scheduler",
        value: (cur: unknown) => {
          const was = (cur as { enabled?: boolean } | null)?.enabled === true;
          if (p.data.enabled && !was && !confirmSpend) refused = true;
          return refused ? cur : p.data;
        },
      },
    ]);
    if (refused) return { ok: false, error: "Tick the box to confirm that overnight drafting spends money (up to your limits). Nothing was saved." };
    return { ok: true, changed };
  } catch {
    return { ok: false, error: GENERIC };
  }
}

/** The saved scheduler settings; a hand-edited bad value falls back to the defaults. */
export async function loadScheduler(db: pg.Pool): Promise<SchedulerSettings> {
  const p = schedulerSchema.safeParse(await getSetting(db, "scheduler"));
  return p.success ? p.data : SCHEDULER_DEFAULTS;
}
