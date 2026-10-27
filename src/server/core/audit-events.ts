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
  "google_app.saved": "The Google app details were saved",
  "google_app.tested": "The Google app details were format-checked",
  "vault.init": "The vault master key was initialised",
  "vault.unreadable": "A vault entry could not be decrypted",
  // Phase 2 gates (detail: video id, gate, short hash prefix only)
  "gate.approved": "A gate was approved",
  "gate.sent_back": "A gate was sent back",
  // Phase 2 notifications (detail: event, channel, error class only)
  "notify.delivery_failed": "A notification channel failed to deliver",
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
