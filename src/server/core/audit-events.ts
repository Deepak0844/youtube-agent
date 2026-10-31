// Audit event catalogue and detail redaction. Pure: no IO. The writer lives in src/server/db/audit.ts.
// Only event names listed here can be written through recordAudit (compile time and runtime).

export const AUDIT_EVENTS = {
  // Phase 1 foundations
  "setting.changed": "A system setting changed",
  "key.set": "An API key was saved to the vault",
  "key.removed": "An API key was removed from the vault",
  "key.tested": "An API key was tested",
  "model.added": "A model was added to the catalog",
  "model.changed": "A model in the catalog changed",
  "model.removed": "A model was removed from the catalog",
  "route.changed": "A model route changed",
  "model.tested": "A model was tested with one small call",
  // Claude Code on this machine (ADR 0014; detail: source, stage -> model id before/after; result class only)
  "ai_source.changed": "The AI source for text stages was switched",
  "claude_code.tested": "Claude Code was tested with one tiny call",
  "google_app.saved": "The Google app details were saved",
  "google_app.tested": "The Google app details were format-checked",
  "vault.init": "The vault master key was initialised",
  "vault.unreadable": "A vault entry could not be decrypted",
  // Phase 2 gates (detail: video id, gate, short hash prefix only)
  "gate.approved": "A gate was approved",
  "gate.sent_back": "A gate was sent back",
  // Phase 2 publish (detail: ids, 12-character hash prefixes, content version ids; never a full hash or a file path)
  "publish.approved": "A publish was approved and queued for upload",
  "upload.started": "An approved upload began",
  "upload.refused": "A queued upload was refused before it began",
  // Phase 2 retries (detail: stage name and session id only)
  "breaker.reset": "A paused stage was released by the owner",
  // Phase 2 parked stages (detail: stage run id, video id, choice, reason, session id, dollar figure; never a call key)
  "stage.decision": "The owner resolved a parked stage",
  // Parked stage, "check the job" (detail: stage run id, video id, provider, provider job id, outcome, session id; never a key or a file path)
  "stage.job_checked": "The owner asked a provider about a parked paid job",
  // Phase 2 queue page (detail: ids and session id only)
  "video.cancelled": "The owner cancelled a video",
  "upload.requeued": "An approved upload was sent to the uploader again",
  "video.created": "The owner started a new video",
  "dryrun.started": "A development dry run was started",
  // Phase 2 notifications (detail: event, channel, error class only)
  "notify.delivery_failed": "A notification channel failed to deliver",
  // Phase 3 budgets (detail: template scope, old and new cap in micro-USD; null means no limit)
  "budget.cap_changed": "A spending cap was changed",
  // Phase 3 providers page (detail: provider id, enabled; media route changes reuse route.changed with kind, scope, provider, voice)
  "provider.toggled": "A media provider was switched on or off",
  // Phase 3 captions (detail: video id, session id)
  "captions.checked": "The owner ticked that the approximate captions were checked",
  // Phase 3 asset ingest (detail: ingest job id, kind, asset id, whether it was a duplicate; never a file name or path)
  "asset.added": "An uploaded file was checked and added to the library",
  "asset.upload_refused": "An uploaded file was refused",
  // Phase 3 assets page (detail: asset ids and counts only; never a file name or path)
  "asset.kept": "An asset's Keep switch was changed",
  "asset.deleted": "Assets were moved to the trash",
  "asset.restored": "An asset was restored from the trash",
  "asset.tagged": "Tags were added to assets",
  // Phase 4 scenes (detail: video id, scene ids, versions, session id; never scene text)
  "scenes.rechecked": "The saved scenes were re-checked against the house rules (free)",
  "scenes.repaired": "Failing scenes were repaired into a new version",
  "scenes.undone": "The previous scenes version was made current again",
  // Already written by owner setup, login and TOTP code
  "owner.created": "Owner account created",
  "owner.reset_completed": "Owner account reset completed",
  "owner.create_link": "Owner setup link issued",
  "owner.reset_link": "Owner reset link issued",
  "login.success": "Owner signed in",
  "login.failure": "Owner sign-in failed",
  "password.changed": "Owner password changed",
  "password.change_failure": "Owner password change failed",
  "totp.enabled": "Two-factor sign-in enabled",
  "totp.disabled": "Two-factor sign-in disabled",
  "totp.backfilled": "Existing two-factor secrets were encrypted into the vault",
  "totp.recovery_regenerated": "Recovery codes regenerated",
} as const;

export type AuditEvent = keyof typeof AUDIT_EVENTS;

export function isAuditEvent(e: unknown): e is AuditEvent {
  return typeof e === "string" && Object.hasOwn(AUDIT_EVENTS, e);
}

export const REDACTED = "[redacted]";
const REDACTED_KEY = "[redacted-key]";

// Key names that may hold a secret. Deliberately broad (fail safe): a harmless field that matches is blanked, never stored.
const SECRET_KEY_RE = /secret|pass|pwd|token|code|key|authorization|cookie|totp|otp|credential|bearer/i;
// A run of 32+ URL-safe / base64 characters anywhere in a string looks like a token, hash, key or link.
const LONG_TOKEN_RE = /[A-Za-z0-9_+/=-]{32,}/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i; // row ids are not secrets
const MAX_DEPTH = 8;

const looksSecret = (s: string) => !UUID_RE.test(s) && LONG_TOKEN_RE.test(s);

export interface Redaction {
  safe: Record<string, unknown>;
  /** Key names (never values) that were blanked, so a caller bug is visible without leaking anything. */
  redacted: string[];
}

export function redactDetail(detail: Record<string, unknown> = {}): Redaction {
  const redacted: string[] = [];
  const seen = new WeakSet<object>();

  const walk = (v: unknown, key: string, depth: number): unknown => {
    switch (typeof v) {
      case "string":
        if (looksSecret(v)) return (redacted.push(key), REDACTED);
        return v;
      case "number":
      case "boolean":
        return v;
      case "bigint":
        return v.toString();
      case "object": {
        if (v === null) return null;
        if (depth >= MAX_DEPTH) return (redacted.push(key), REDACTED); // too deep to inspect, so not stored
        if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
        if (seen.has(v)) return "[circular]";
        seen.add(v);
        const out = Array.isArray(v) ? v.map((x) => walk(x, key, depth + 1)) : walkObject(v as Record<string, unknown>, depth);
        seen.delete(v);
        return out;
      }
      default:
        return undefined; // undefined, function, symbol: not storable
    }
  };

  const walkObject = (o: Record<string, unknown>, depth: number): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o)) {
      if (k === "__proto__") continue;
      if (looksSecret(k)) {
        redacted.push(REDACTED_KEY);
        out[`${REDACTED_KEY}:${redacted.length}`] = REDACTED;
        continue;
      }
      if (SECRET_KEY_RE.test(k)) {
        redacted.push(k);
        out[k] = REDACTED;
        continue;
      }
      let val: unknown;
      try {
        val = o[k];
      } catch {
        redacted.push(k); // a throwing getter is not trusted
        out[k] = REDACTED;
        continue;
      }
      const w = walk(val, k, depth + 1);
      if (w !== undefined) out[k] = w;
    }
    return out;
  };

  return { safe: walkObject(detail ?? {}, 0), redacted };
}
