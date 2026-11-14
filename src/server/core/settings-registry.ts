import { z } from "zod";
import { backupResultSchema } from "@/server/core/backup";
import { checkWebhookUrl } from "@/server/core/notify-send";
import { SCHEDULER_DEFAULTS, schedulerSchema } from "@/server/core/scheduler";
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
  // Result of the last backup (Phase 7). Written only by the session-only Back up now action; not a safety key.
  // The optional second copy of every backup (a folder or external drive the owner names; empty = off). Not a safety key: it only adds a copy.
  "backup.extra_dir": { schema: z.string().max(400), default: "", safety: false, label: "Extra backup folder (optional)" },
  "backup.last_run": { schema: backupResultSchema, default: null, safety: false, label: "Last backup result" },
  // Scheduler (Phase 6). Safety: it decides whether the app drafts videos and spends money while the owner is away.
  scheduler: { schema: schedulerSchema, default: SCHEDULER_DEFAULTS, safety: true, label: "Scheduler" },
  // Targets (Phase 6.2). pause_fired is written only by pauseDraftingForTargets (settings.ts) and cleared when the owner saves the rule.
  "targets.pause_n": { schema: nonNegInt.max(50), default: 0, safety: false, label: "Pause drafting after this many shorts over the cost target (0 = off)" },
  "targets.rpm_usd": { schema: z.number().finite().min(0).max(1000), default: 0, safety: false, label: "Revenue per 1,000 views, dollars (estimate only)" },
  "targets.pause_fired": { schema: z.string().nullable(), default: null, safety: false, label: "When the pause rule last paused drafting" },
  "jobs.concurrent_renders": { schema: posInt, default: 1, safety: false, label: "Concurrent renders" },
  "jobs.concurrent_jobs": { schema: posInt, default: 2, safety: false, label: "Concurrent jobs" },
  "storage.warn_gb": { schema: posInt, default: 50, safety: false, label: "Storage warning (GB)" },
  // Asset ingest (Doc 13 9). All safety: raising them weakens the upload limits.
  "assets.max_image_bytes": { schema: posInt, default: 26_214_400, safety: true, label: "Max image size (bytes)" },
  "assets.max_audio_bytes": { schema: posInt, default: 209_715_200, safety: true, label: "Max audio file size (bytes)" },
  "assets.max_pixels": { schema: posInt, default: 50_000_000, safety: true, label: "Max image size (pixels)" },
  "assets.max_batch_files": { schema: posInt, default: 100, safety: true, label: "Max files per batch" },
  "assets.total_bytes_cap": { schema: posInt, default: 5_368_709_120, safety: true, label: "Total uploaded bytes cap" },
  // Auto-delete of uploads (Doc 13 4). Safety: they decide when files are removed.
  "assets.retention_days": { schema: posInt.max(60), default: 7, safety: true, label: "Days to keep a finished video's uploads" },
  "assets.unused_days": { schema: posInt.max(365), default: 30, safety: true, label: "Days to keep an upload no video uses" },
  "assets.trash_days": { schema: posInt.max(60), default: 7, safety: true, label: "Days a deleted file stays in the trash" },
  "video.max_long_minutes": { schema: posInt, default: 15, safety: false, label: "Max long video (minutes)" },
  // Hidden in the UI until their phases ship.
  "tracks.enabled": {
    schema: z.object({ tsx: z.boolean(), collage: z.boolean(), ai: z.boolean() }).strict(),
    default: { tsx: true, collage: true, ai: true },
    safety: false,
    label: "Enabled tracks",
  },
  "policy.require_evidence": { schema: z.boolean(), default: true, safety: true, label: "Require evidence" },
  "policy.allow_public": { schema: z.boolean(), default: false, safety: true, label: "Allow public publishing (global kill switch)" },
  // Upload switches (Phase 5). Safety: the kill switch refuses every upload; cutover_done lets production channels receive uploads.
  "uploads.kill_switch": { schema: z.boolean(), default: false, safety: true, label: "Stop every upload (kill switch)" },
  // Comment replies (Phase 5 slice 5b). Dry run is ON until the owner turns it off: "post" then only records the request that would be sent.
  "comments.dry_run": { schema: z.boolean(), default: true, safety: true, label: "Comment replies are a dry run (nothing is posted to YouTube)" },
  "youtube.cutover_done": { schema: z.boolean(), default: false, safety: true, label: "Go-live cutover done (production channels may upload)" },
  "network.local_services": { schema: z.array(z.string().min(1)), default: [] as string[], safety: true, label: "Local services (host:port)" },
  // Engine numbers (Doc 02 4.7, agent gap G5). All safety: they bound retries, spend exposure and what counts as a good video.
  // Defaults come from the old agent/config.py and agent/qa.py (docs/spec/old-app-snapshot-2026-10-26); where the plan and
  // the old code differ the old number wins (log_cap_bytes: config.py line 31 is 5_000_000, not 5 MiB).
  "engine.retry_attempts": { schema: posInt.max(10), default: 3, safety: true, label: "Stage tries in total, first try included (config.py:27). Default 3 = waits of 30 and 120 s (the 480 s wait is used only if set to 4). Also the crash re-claim limit" },
  "engine.retry_backoff_seconds": { schema: z.array(posInt.max(86_400)).min(1).max(10), default: [30, 120, 480], safety: true, label: "Retry back-off seconds (config.py:28)" },
  "engine.timeout_stage_s": { schema: posInt.min(10).max(86_400), default: 1800, safety: true, label: "Stage timeout, seconds (config.py:26)" },
  "engine.timeout_author_s": { schema: posInt.min(10).max(86_400), default: 2400, safety: true, label: "Author stage timeout, seconds (config.py:58)" },
  // The new video engine (ADR 0015): Claude Code with tools in a locked per-video folder. Off until the owner turns it on.
  "engine.enabled": { schema: z.boolean(), default: false, safety: true, label: "New video engine (Claude Code with tools)" },
  "engine.build_timeout_s": { schema: posInt.min(60).max(14_400), default: 2700, safety: true, label: "Engine build run limit for a Short, seconds" },
  "engine.long_build_timeout_s": { schema: posInt.min(60).max(28_800), default: 5400, safety: true, label: "Engine build run limit for a long video, seconds" },
  "engine.max_turns": { schema: posInt.max(500), default: 150, safety: true, label: "Engine run turn limit (150: room to draw and redraw objects; owner 2026-11-14)" },
  "engine.model": { schema: z.enum(["sonnet", "opus"]), default: "sonnet", safety: true, label: "Claude model the engine runs on (owner 2026-11-14: Sonnet by default; Opus draws more carefully and uses the usage limit faster)" },
  "engine.limit_retry_s": { schema: posInt.min(60).max(86_400), default: 1800, safety: true, label: "Retry gap after the Claude usage limit when no reset time is given, seconds" },
  "engine.timeout_live_s": { schema: posInt.min(60).max(172_800), default: 43200, safety: true, label: "Live stage timeout, seconds (Doc 02 4.7: 12 h)" },
  "engine.lease_s": { schema: posInt.min(5).max(3600), default: 60, safety: true, label: "Stage lease, seconds (config.py:29)" },
  "engine.heartbeat_s": { schema: posInt.max(600), default: 5, safety: true, label: "Heartbeat, seconds (config.py:30)" },
  "engine.log_cap_bytes": { schema: posInt, default: 5_000_000, safety: true, label: "Stage log cap, bytes (config.py:31)" },
  // Reserved: unused until the owner reverses open question 4 (cheap text steps).
  "engine.cheap_text_run_budget_micro_usd": { schema: nonNegInt, default: 50_000, safety: true, label: "Cheap text run budget (micro-USD, reserved)" },
  "breaker.threshold": { schema: nonNegInt.max(100), default: 3, safety: true, label: "Breaker threshold, 0 = off (config.py:46)" },
  "breaker.cooldown_s": { schema: nonNegInt.max(86_400), default: 900, safety: true, label: "Breaker cooldown, seconds (config.py:47)" },
  "breaker.stages": { schema: z.array(z.string().min(1)), default: ["draft", "build", "voice"], safety: true, label: "Breaker stages (config.py:48)" },
  "uploads.concurrent": { schema: posInt, default: 1, safety: true, label: "Concurrent uploads (Doc 02 4.7: one at a time)" },
  // QA (agent/config.py:33-35 and :57, agent/qa.py).
  "qa.width": { schema: posInt, default: 1080, safety: true, label: "QA short width" },
  "qa.height": { schema: posInt, default: 1920, safety: true, label: "QA short height" },
  "qa.min_s": { schema: posNum.min(1).max(7200), default: 15, safety: true, label: "QA short min seconds" },
  "qa.max_s": { schema: posNum.min(1).max(7200), default: 60, safety: true, label: "QA short max seconds" },
  "qa.mean_db_min": { schema: num.min(-100).max(0), default: -40, safety: true, label: "QA mean loudness floor (dB)" },
  "qa.peak_db_max": { schema: num.min(-20).max(0), default: -0.3, safety: true, label: "QA peak ceiling (dB)" },
  "qa.loop_diff_max": { schema: posNum.min(0.1).max(255), default: 14, safety: true, label: "QA loop seam difference (of 255)" },
  "qa.duration_tolerance_s": { schema: posNum.min(0.1).max(60), default: 1.5, safety: true, label: "QA duration tolerance (s)" },
  "qa.long_width": { schema: posInt, default: 1920, safety: true, label: "QA long width" },
  "qa.long_height": { schema: posInt, default: 1080, safety: true, label: "QA long height" },
  "qa.long_min_s": { schema: posNum.min(1).max(86_400), default: 180, safety: true, label: "QA long min seconds" },
  "qa.long_max_s": { schema: posNum.min(1).max(86_400), default: 900, safety: true, label: "QA long max seconds" },
  // Render sandbox limits (ADR 0003). Safety: raising them loosens the container. Upper bounds keep a ceiling.
  "render.timeout_s": { schema: posInt.max(3600), default: 600, safety: true, label: "Render time limit, seconds" },
  "render.cpus": { schema: posInt.max(32), default: 4, safety: true, label: "Render CPUs" },
  "render.memory_mb": { schema: posInt.min(1024).max(16384), default: 4096, safety: true, label: "Render memory (MB)" },
  "render.pids": { schema: posInt.min(64).max(2048), default: 512, safety: true, label: "Render process limit" },
  "notify.master": { schema: z.boolean(), default: true, safety: false, label: "Notifications on (master switch)" },
  "notify.quiet_hours": { schema: quietHours, default: { enabled: false, start: "22:00", end: "07:00", tz: "Asia/Kolkata" }, safety: false, label: "Quiet hours" },
  // Where the webhook channel posts. Safety: it decides where studio text is sent. "" = none. Public addresses only (checked again at send time).
  "notify.webhook_url": { schema: z.string().max(2000).refine((v) => v === "" || checkWebhookUrl(v) === null, "not an allowed webhook address"), default: "", safety: true, label: "Notification webhook URL" },
  "notify.events": { schema: notifyEvents, default: DEFAULT_EVENT_SWITCHES as Record<string, unknown>, safety: false, label: "Notification switches per event and channel" },
  // Voice servers (Doc 13 5): where the adapters without a fixed address live. Empty = not set up. Server addresses are safety keys (they decide where the script text is sent).
  "voice.azure_region": { schema: z.string().regex(/^([a-z0-9-]{3,30})?$/), default: "", safety: false, label: "Azure speech region" },
  "voice.local_url": { schema: z.string().max(300), default: "", safety: true, label: "Local voice server address" },
  "voice.voicestudio_url": { schema: z.string().max(300), default: "", safety: true, label: "VoiceStudio address" },
  // Claude Code text provider (ADR 0014). Safety: turning it on starts a program on this machine; the cap bounds subscription use.
  "llm.call_gap_ms": { schema: nonNegInt.max(60_000), default: 6000, safety: true, label: "Minimum gap between calls to the same hosted model, ms (free-tier rate limits, default 6 s)" },
  "claude_code.enabled": { schema: z.boolean(), default: false, safety: true, label: "Claude Code on this machine for text stages" },
  "claude_code.daily_cap": { schema: posInt.max(10_000), default: 200, safety: true, label: "Claude Code calls per UTC day" },
  // The routes the "AI source" switch replaced (stage -> model id, or null for none); null = the switch is off. Safety:
  // turning the switch off writes these back as routes.
  "ai.previous_routes": {
    schema: z.record(z.string().regex(/^[a-z0-9_]{1,40}$/), z.string().uuid().nullable()).nullable(),
    default: null,
    safety: true,
    label: "Routes to restore when Claude Code is switched off",
  },
  // The rupee rate is refreshed once a day from a free public rate service (src/server/core/fx-rate.ts); off = only the typed rate is used.
  "display.inr_auto": { schema: z.boolean(), default: true, safety: false, label: "Update the rupee rate automatically each day" },
  // Where and when the automatic rate came from (null until the first fetch). Written only by the refresh.
  "display.inr_meta": { schema: z.object({ source: z.string().min(1).max(40), rateDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), fetchedAt: z.string().min(10).max(40) }).strict().nullable(), default: null, safety: false, label: "Where and when the rupee rate was fetched" },
  "display.inr_rate": { schema: z.number().positive().max(10_000), default: 95.05, safety: false, label: "Rupees per US dollar (display only)" },
  "display.currency": { schema: z.string().min(1), default: "USD", safety: false, label: "Display currency" },
} satisfies Record<string, SettingDef>;

export type SettingKey = keyof typeof SETTINGS;

export const SAFETY_KEYS = (Object.keys(SETTINGS) as SettingKey[]).filter((k) => SETTINGS[k].safety);

// Default spend caps in micro-USD (Doc 02 4.5). Scope names are free-form strings in `budgets.scope`.
export const BUDGET_DEFAULTS: Record<string, number> = {
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
