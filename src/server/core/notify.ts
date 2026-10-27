// Notification events, per-channel switches, quiet hours and the pure delivery decision (Doc 04 5). No IO.
// A notification fires only on a transition INTO an event's state; desktop popup and webhook senders plug in through ports (Phase 7).

export const CHANNELS = ["in_app", "desktop", "webhook"] as const;
export type Channel = (typeof CHANNELS)[number];
export type ChannelSwitches = Record<Channel, boolean>;

export type NotifyGroup = "needs_you" | "problems" | "good_news";

export interface NotifyEventDef {
  readonly group: NotifyGroup;
  readonly title: string;
  /** The state a video (or run) must move INTO for this event to fire. */
  readonly state: string;
  /** May break through quiet hours when the owner allows it. */
  readonly urgent: boolean;
}

const ev = (group: NotifyGroup, title: string, state: string, urgent = false): NotifyEventDef => Object.freeze({ group, title, state, urgent });

export const NOTIFY_EVENTS = Object.freeze({
  // Needs you
  outline_review: ev("needs_you", "Outline needs review", "gate.outline"),
  script_review: ev("needs_you", "Script ready for review", "gate.script"),
  cost_approval: ev("needs_you", "Cost approval needed", "gate.cost"),
  chapter_ready: ev("needs_you", "Chapter ready for review", "gate.chapter"),
  video_review: ev("needs_you", "Video ready for review", "gate.video"),
  evidence_signoff: ev("needs_you", "Evidence needs sign-off", "gate.evidence"),
  publish_approval: ev("needs_you", "Publish approval needed", "gate.publish"),
  comment_replies: ev("needs_you", "Comment replies waiting", "gate.comment_reply"),
  needs_decision: ev("needs_you", "Needs your decision: a paid call may have run", "needs_decision", true),
  // Problems
  video_failed: ev("problems", "Video failed", "failed"),
  video_blocked: ev("problems", "Video blocked", "blocked"),
  upload_failed: ev("problems", "Upload failed", "upload_failed"),
  spend_cap_hit: ev("problems", "Spend cap or breaker hit", "spend_cap_hit", true),
  google_login_expired: ev("problems", "Google login expired, reconnect the channel", "google_login_expired"),
  run_failed: ev("problems", "Research or scheduler run failed", "run_failed"),
  backup_failed: ev("problems", "Backup failed", "backup_failed"),
  drafting_paused: ev("problems", "Unattended drafting paused", "drafting_paused"),
  // Good news
  uploaded_private: ev("good_news", "Uploaded (private)", "uploaded_private"),
  scheduled_release_done: ev("good_news", "Scheduled release done", "scheduled_release_done"),
  weekly_review_ready: ev("good_news", "Weekly review ready", "weekly_review_ready"),
} satisfies Record<string, NotifyEventDef>);

export type NotifyEventId = keyof typeof NOTIFY_EVENTS;
export const NOTIFY_EVENT_IDS = Object.keys(NOTIFY_EVENTS) as NotifyEventId[];
export const isNotifyEvent = (v: unknown): v is NotifyEventId => typeof v === "string" && Object.hasOwn(NOTIFY_EVENTS, v);

/** Doc 04 5 defaults: Needs you and Problems on for popup and in-app; webhook off until configured; Good news in-app only. */
export function defaultSwitches(id: NotifyEventId): ChannelSwitches {
  const loud = NOTIFY_EVENTS[id].group !== "good_news";
  return { in_app: true, desktop: loud, webhook: false };
}

export const DEFAULT_EVENT_SWITCHES = Object.fromEntries(NOTIFY_EVENT_IDS.map((id) => [id, defaultSwitches(id)])) as Record<NotifyEventId, ChannelSwitches>;

export interface QuietHours {
  enabled: boolean;
  start: string; // "HH:MM" local
  end: string;
  tz: string; // IANA
  /** Urgent events (needs_decision, spend_cap_hit) ignore the window when true. */
  urgent_break_through?: boolean;
}

export interface NotifySettings {
  master: boolean;
  quietHours: QuietHours;
  events: Partial<Record<string, Partial<ChannelSwitches>>>;
}

/** The event that fires when something moves INTO `state`, or null (only gate and failure states notify). */
export function eventForState(state: string): NotifyEventId | null {
  return NOTIFY_EVENT_IDS.find((id) => NOTIFY_EVENTS[id].state === state) ?? null;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const isHhmm = (s: string): boolean => HHMM.test(s);
const hhmm = (s: string): number => {
  const m = HHMM.exec(s);
  if (!m) throw new RangeError(`bad time: ${s}`);
  return Number(m[1]) * 60 + Number(m[2]);
};

export const isTimeZone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/** Wall-clock minutes since local midnight in an IANA zone. Wall time is what the owner's window means, so a DST jump needs no special case. */
export function localMinutes(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return get("hour") * 60 + get("minute");
}

/** True when `nowMin` is inside [start, end). start == end is an empty window. start > end crosses midnight. */
export function inQuietHours(q: QuietHours, nowMin: number): boolean {
  if (!q.enabled) return false;
  const s = hhmm(q.start);
  const e = hhmm(q.end);
  if (s === e) return false;
  return s < e ? nowMin >= s && nowMin < e : nowMin >= s || nowMin < e;
}

export interface Delivery {
  channel: Channel;
  deliver: boolean;
  held: boolean;
}

/**
 * Pure. In-app is the record and is always delivered (even with the master switch off). Desktop and webhook need the master
 * switch and their event switch, and are held (not sent) during quiet hours unless the event is urgent and break-through is on.
 */
export function decideDelivery(event: NotifyEventId, settings: NotifySettings, nowLocalMinutes: number): Delivery[] {
  const sw = { ...defaultSwitches(event), ...(settings.events[event] ?? {}) };
  const quiet = inQuietHours(settings.quietHours, nowLocalMinutes);
  const breaks = NOTIFY_EVENTS[event].urgent && settings.quietHours.urgent_break_through === true;
  return CHANNELS.map((channel): Delivery => {
    if (channel === "in_app") return { channel, deliver: true, held: false };
    if (!settings.master || !sw[channel]) return { channel, deliver: false, held: false };
    if (quiet && !breaks) return { channel, deliver: false, held: true };
    return { channel, deliver: true, held: false };
  });
}

// Anything that looks like a credential is removed from text before it is stored or sent anywhere.
const SECRET_SHAPES: RegExp[] = [
  /https?:\/\/\S*[?&](?:X-Amz-Signature|signature|sig|token|key|access_token)=\S*/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bAIza[A-Za-z0-9_-]{20,}/g,
  /\b(?:xai|gsk|pplx|ya29|ghp|gho|xox[abp])[-_][A-Za-z0-9_.-]{8,}/g,
  /[A-Za-z0-9_+/=-]{32,}/g,
];
export const REDACTED_TEXT = "[redacted]";
export function scrubText(s: string): string {
  return SECRET_SHAPES.reduce((acc, re) => acc.replace(re, REDACTED_TEXT), s).slice(0, 500);
}
