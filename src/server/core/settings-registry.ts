import { z } from "zod";
import { DEFAULT_EVENT_SWITCHES, NOTIFY_EVENT_IDS, isHhmm, isTimeZone } from "@/server/core/notify";

// Pure registry of owner settings (Docs 02 4.5-4.7, 07 3). `safety` keys weaken protections when changed, so only a
// logged-in session may write them (never an API token or the system). The SQL seed in 0005_settings.sql must match.
export interface SettingDef {
  schema: z.ZodType;
  default: unknown;
  safety: boolean;
  label: string;
}

const posInt = z.number().int().positive();
const nonNegInt = z.number().int().nonnegative();
const num = z.number().finite();
const posNum = z.number().finite().positive();

const hhmm = z.string().refine(isHhmm, "use HH:MM");
const switches = z.object({ in_app: z.boolean(), desktop: z.boolean(), webhook: z.boolean() }).strict();
// Notifications (Doc 04 5). None is a safety key: they only change who is told, never what is allowed.
const notifyEvents = z
  .record(z.string(), switches)
  .refine((m) => Object.keys(m).every((k) => (NOTIFY_EVENT_IDS as string[]).includes(k)), "unknown notification event");
const quietHours = z
  .object({ enabled: z.boolean(), start: hhmm, end: hhmm, tz: z.string().refine(isTimeZone, "unknown time zone"), urgent_break_through: z.boolean().optional() })
  .strict();

export const SETTINGS = {
  "jobs.concurrent_renders": { schema: posInt, default: 1, safety: false, label: "Concurrent renders" },
  "jobs.concurrent_jobs": { schema: posInt, default: 2, safety: false, label: "Concurrent jobs" },
  "storage.warn_gb": { schema: posInt, default: 50, safety: false, label: "Storage warning (GB)" },
  "uploads.max_image_mb": { schema: posInt, default: 25, safety: false, label: "Max image size (MB)" },
  "uploads.max_image_mp": { schema: posInt, default: 50, safety: false, label: "Max image size (megapixels)" },
  "uploads.total_gb": { schema: posInt, default: 5, safety: false, label: "Total uploads (GB)" },
  // Asset ingest (Doc 13 9). All safety: raising them weakens the upload limits.
  "assets.max_image_bytes": { schema: posInt, default: 26_214_400, safety: true, label: "Max image size (bytes)" },
  "assets.max_pixels": { schema: posInt, default: 50_000_000, safety: true, label: "Max image size (pixels)" },
  "assets.max_batch_files": { schema: posInt, default: 100, safety: true, label: "Max files per batch" },
  "assets.total_bytes_cap": { schema: posInt, default: 5_368_709_120, safety: true, label: "Total uploaded bytes cap" },
  "video.max_long_minutes": { schema: posInt, default: 15, safety: false, label: "Max long video (minutes)" },
  // Hidden in the UI until their phases ship.
  "tracks.enabled": {
    schema: z.object({ scene_kit: z.boolean(), tsx: z.boolean(), collage: z.boolean(), ai: z.boolean() }).strict(),
    default: { scene_kit: true, tsx: true, collage: true, ai: true },
    safety: false,
    label: "Enabled tracks",
  },
  "policy.require_evidence": { schema: z.boolean(), default: true, safety: true, label: "Require evidence" },
  "policy.allow_public": { schema: z.boolean(), default: false, safety: true, label: "Allow public publishing (global kill switch)" },
  "network.local_services": { schema: z.array(z.string().min(1)), default: [] as string[], safety: true, label: "Local services (host:port)" },
  // Engine numbers (Doc 02 4.7, agent gap G5). All safety: they bound retries, spend exposure and what counts as a good video.
  // Defaults come from the old agent/config.py and agent/qa.py (docs/spec/old-app-snapshot-2026-10-26); where the plan and
  // the old code differ the old number wins (log_cap_bytes: config.py line 31 is 5_000_000, not 5 MiB).
  "engine.retry_attempts": { schema: posInt.max(10), default: 3, safety: true, label: "Stage tries in total, first try included (config.py:27). Default 3 = waits of 30 and 120 s (the 480 s wait is used only if set to 4). Also the crash re-claim limit" },
  "engine.retry_backoff_seconds": { schema: z.array(posInt).min(1).max(10), default: [30, 120, 480], safety: true, label: "Retry back-off seconds (config.py:28)" },
  "engine.timeout_stage_s": { schema: posInt, default: 1800, safety: true, label: "Stage timeout, seconds (config.py:26)" },
  "engine.timeout_author_s": { schema: posInt, default: 2400, safety: true, label: "Author stage timeout, seconds (config.py:58)" },
  "engine.timeout_live_s": { schema: posInt, default: 43200, safety: true, label: "Live stage timeout, seconds (Doc 02 4.7: 12 h)" },
  "engine.lease_s": { schema: posInt, default: 60, safety: true, label: "Stage lease, seconds (config.py:29)" },
  "engine.heartbeat_s": { schema: posInt, default: 5, safety: true, label: "Heartbeat, seconds (config.py:30)" },
  "engine.log_cap_bytes": { schema: posInt, default: 5_000_000, safety: true, label: "Stage log cap, bytes (config.py:31)" },
  // Reserved: unused until the owner reverses open question 4 (cheap text steps).
  "engine.cheap_text_run_budget_micro_usd": { schema: nonNegInt, default: 50_000, safety: true, label: "Cheap text run budget (micro-USD, reserved)" },
  "breaker.threshold": { schema: nonNegInt, default: 3, safety: true, label: "Breaker threshold, 0 = off (config.py:46)" },
  "breaker.cooldown_s": { schema: nonNegInt, default: 900, safety: true, label: "Breaker cooldown, seconds (config.py:47)" },
  "breaker.stages": { schema: z.array(z.string().min(1)), default: ["draft", "build", "voice"], safety: true, label: "Breaker stages (config.py:48)" },
  "uploads.concurrent": { schema: posInt, default: 1, safety: true, label: "Concurrent uploads (Doc 02 4.7: one at a time)" },
  // QA (agent/config.py:33-35 and :57, agent/qa.py).
  "qa.width": { schema: posInt, default: 1080, safety: true, label: "QA short width" },
  "qa.height": { schema: posInt, default: 1920, safety: true, label: "QA short height" },
  "qa.min_s": { schema: posNum, default: 15, safety: true, label: "QA short min seconds" },
  "qa.max_s": { schema: posNum, default: 60, safety: true, label: "QA short max seconds" },
  "qa.mean_db_min": { schema: num, default: -40, safety: true, label: "QA mean loudness floor (dB)" },
  "qa.peak_db_max": { schema: num, default: -0.3, safety: true, label: "QA peak ceiling (dB)" },
  "qa.loop_diff_max": { schema: posNum, default: 14, safety: true, label: "QA loop seam difference (of 255)" },
  "qa.duration_tolerance_s": { schema: posNum, default: 1.5, safety: true, label: "QA duration tolerance (s)" },
  "qa.long_width": { schema: posInt, default: 1920, safety: true, label: "QA long width" },
  "qa.long_height": { schema: posInt, default: 1080, safety: true, label: "QA long height" },
  "qa.long_min_s": { schema: posNum, default: 180, safety: true, label: "QA long min seconds" },
  "qa.long_max_s": { schema: posNum, default: 900, safety: true, label: "QA long max seconds" },
  "notify.master": { schema: z.boolean(), default: true, safety: false, label: "Notifications on (master switch)" },
  "notify.quiet_hours": { schema: quietHours, default: { enabled: false, start: "22:00", end: "07:00", tz: "Asia/Kolkata" }, safety: false, label: "Quiet hours" },
  "notify.events": { schema: notifyEvents, default: DEFAULT_EVENT_SWITCHES as Record<string, unknown>, safety: false, label: "Notification switches per event and channel" },
  "display.currency": { schema: z.string().min(1), default: "USD", safety: false, label: "Display currency" },
} satisfies Record<string, SettingDef>;

export type SettingKey = keyof typeof SETTINGS;

export const SAFETY_KEYS = (Object.keys(SETTINGS) as SettingKey[]).filter((k) => SETTINGS[k].safety);

// Default spend caps in micro-USD (Doc 02 4.5). Scope names are free-form strings in `budgets.scope`.
export const BUDGET_DEFAULTS: Record<string, number> = {
  "video:scene_kit": 2_000_000,
  "video:tsx": 5_000_000,
  "video:collage": 5_000_000,
  "video:ai": 15_000_000,
  "video:long": 8_000_000,
  day: 15_000_000,
  month: 100_000_000,
  draft_run: 3_000_000,
};

/** Plain words for each template on the Budgets page. Same keys as BUDGET_DEFAULTS. */
export const BUDGET_LABELS: Record<string, { title: string; note: string }> = {
  "video:scene_kit": { title: "Scene-kit video", note: "The most one scene-kit video may spend." },
  "video:tsx": { title: "Code-scene video", note: "The most one code-scene video may spend." },
  "video:collage": { title: "Collage video", note: "The most one collage video may spend." },
  "video:ai": { title: "AI video", note: "The most one AI-generated video may spend." },
  "video:long": { title: "Long video", note: "The most one long-form video may spend." },
  day: { title: "Per day", note: "The most the whole studio may spend in one UTC day." },
  month: { title: "Per month", note: "The most the whole studio may spend in one UTC month." },
  draft_run: { title: "Per draft run", note: "The most one draft run may spend." },
};

export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(SETTINGS, key);
}

// Throws on an unknown key or an invalid value; returns the parsed value.
export function parseSetting(key: string, value: unknown): unknown {
  if (!isSettingKey(key)) throw new Error(`unknown setting: ${key}`);
  return SETTINGS[key].schema.parse(value);
}
