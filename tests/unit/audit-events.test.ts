import { describe, expect, it } from "vitest";
import { AUDIT_EVENTS, isAuditEvent, redactDetail } from "@/server/core/audit-events";

const REDACTED = "[redacted]";
const TOKEN = "Zx9_Qw3-Er5TyUi7OpAsDfGhJkLzXcVbNm12";

describe("audit event catalogue", () => {
  it("has_the_phase_1_events", () => {
    for (const e of ["setting.changed", "key.set", "key.removed", "key.tested", "model.added", "model.changed", "model.removed", "route.changed", "google_app.saved", "google_app.tested", "vault.init", "vault.unreadable"]) {
      expect(isAuditEvent(e)).toBe(true);
    }
  });

  it("keeps_the_events_already_written_by_auth_and_owner", () => {
    for (const e of ["login.success", "login.failure", "password.changed", "password.change_failure", "owner.created", "owner.reset_completed", "owner.create_link", "owner.reset_link", "totp.enabled", "totp.disabled", "totp.recovery_regenerated"]) {
      expect(isAuditEvent(e)).toBe(true);
    }
  });

  it("refuses_unknown_and_prototype_names", () => {
    for (const e of ["nope", "", "constructor", "__proto__", "toString", 5, null, undefined]) expect(isAuditEvent(e)).toBe(false);
    expect(Object.keys(AUDIT_EVENTS).length).toBeGreaterThan(20);
  });
});

describe("redactDetail", () => {
  it("blanks_secret_named_keys_in_any_case_or_style", () => {
    const keys = ["password", "Password", "newPassword", "api_key", "apiKey", "API-KEY", "token", "accessToken", "refresh_token", "secret", "client_secret", "totp_secret", "totpSecret", "recoveryCodes", "recovery_code", "code", "authorization", "Authorization", "cookie", "set-cookie", "otp"];
    for (const k of keys) {
      const { safe, redacted } = redactDetail({ [k]: "hunter2", keep: "fine" });
      expect(safe).toEqual({ [k]: REDACTED, keep: "fine" });
      expect(redacted).toContain(k);
    }
  });

  it("blanks_long_token_shaped_values_wherever_they_hide", () => {
    const b64 = "dGhpcyBpcyBhIHNlY3JldCBrZXkgdmFsdWU9PT0+/abc";
    const { safe } = redactDetail({
      a: TOKEN,
      b: `https://x.test/setup/${TOKEN}`,
      c: { d: [{ e: TOKEN }, "ok"] },
      f: b64,
      g: "a".repeat(64),
      h: `Bearer ${TOKEN}`,
      sk: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
    });
    const flat = JSON.stringify(safe);
    expect(flat).not.toContain(TOKEN);
    expect(flat).not.toContain("dGhpcyBpcyBh");
    expect(flat).not.toContain("aaaaaaaa");
    expect(flat).not.toContain("sk-ant");
    expect((safe as { c: { d: unknown[] } }).c.d[1]).toBe("ok");
  });

  it("blanks_a_secret_used_as_a_property_name", () => {
    const { safe } = redactDetail({ [TOKEN]: "x" });
    expect(JSON.stringify(safe)).not.toContain(TOKEN);
  });

  it("keeps_harmless_values", () => {
    const d = { name: "openai", model: "gpt-4o", n: 3, ok: true, none: null, ip: "10.0.0.1", from: "a", to: "b", id: "0190f2c4-7b1a-7cc0-8f00-000000000001" };
    expect(redactDetail(d)).toEqual({ safe: d, redacted: [] });
  });

  it("survives_cycles_deep_nesting_bigint_and_odd_types", () => {
    const cyc: Record<string, unknown> = { a: 1 };
    cyc.self = cyc;
    let deep: unknown = TOKEN;
    for (let i = 0; i < 40; i++) deep = { x: deep };
    const { safe } = redactDetail({ cyc, deep, big: 10n, d: new Date(0), u: undefined, fn: () => TOKEN });
    expect(JSON.stringify(safe)).not.toContain(TOKEN);
    expect(() => JSON.stringify(safe)).not.toThrow();
  });

  it("does_not_mutate_its_input_and_survives_hostile_getters", () => {
    const input = { password: "p", nested: { token: TOKEN } };
    redactDetail(input);
    expect(input).toEqual({ password: "p", nested: { token: TOKEN } });
    const evil = {
      get boom(): string {
        throw new Error("getter");
      },
    };
    expect(() => redactDetail(evil)).not.toThrow();
  });
});
