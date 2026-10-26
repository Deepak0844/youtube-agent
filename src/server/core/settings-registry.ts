import { z } from "zod";

// Pure registry of owner settings (Docs 02 4.5-4.7, 07 3). `safety` keys weaken protections when changed, so only a
// logged-in session may write them (never an API token or the system). The SQL seed in 0005_settings.sql must match.
export interface SettingDef {
  schema: z.ZodType;
  default: unknown;
  safety: boolean;
  label: string;
}

const posInt = z.number().int().positive();

export const SETTINGS = {
  "jobs.concurrent_renders": { schema: posInt, default: 1, safety: false, label: "Concurrent renders" },
  "jobs.concurrent_jobs": { schema: posInt, default: 2, safety: false, label: "Concurrent jobs" },
  "storage.warn_gb": { schema: posInt, default: 50, safety: false, label: "Storage warning (GB)" },
  "uploads.max_image_mb": { schema: posInt, default: 25, safety: false, label: "Max image size (MB)" },
  "uploads.max_image_mp": { schema: posInt, default: 50, safety: false, label: "Max image size (megapixels)" },
  "uploads.total_gb": { schema: posInt, default: 5, safety: false, label: "Total uploads (GB)" },
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

export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(SETTINGS, key);
}

// Throws on an unknown key or an invalid value; returns the parsed value.
export function parseSetting(key: string, value: unknown): unknown {
  if (!isSettingKey(key)) throw new Error(`unknown setting: ${key}`);
  return SETTINGS[key].schema.parse(value);
}
