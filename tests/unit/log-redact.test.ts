import { describe, expect, it } from "vitest";
import { redactLine } from "@/server/core/log-redact";

const SHAPES = [
  "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
  "sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789",
  "sk-proj1234567890abcdefghijklmnop",
  "gsk_abcdefghijklmnopqrstuvwxyz123456",
  "xai-abcdefghijklmnopqrstuvwxyz123456",
  "AIzaSyA1234567890abcdefghijklmnopqrstu",
];

describe("redactLine", () => {
  it("secret_shapes_are_removed_from_log_lines", () => {
    for (const k of SHAPES) {
      const out = redactLine(`calling provider with ${k} now`);
      expect(out, k).not.toContain(k.slice(6));
      expect(out).toContain("calling provider with");
    }
    expect(redactLine("Authorization: Bearer abcdef1234567890abcdef")).not.toMatch(/abcdef1234567890/);
    expect(redactLine("header Bearer abcdef1234567890abcdef.zzz")).not.toMatch(/abcdef1234567890/);
    expect(redactLine('{"authorization":"Basic dXNlcjpwYXNz"}')).not.toContain("dXNlcjpwYXNz");
    const url = "fetch /api/media/videos/a/final.mp4?e=1790000000&s=AbCdEfGhIjKlMnOpQrStUvWxYz012345678901234 done";
    const out = redactLine(url);
    expect(out).not.toContain("1790000000");
    expect(out).not.toContain("AbCdEfGhIj");
    expect(redactLine("https://x.test/a?sig=abc123&b=1")).toBe("https://x.test/a?sig=[redacted]&b=1");
    expect(redactLine("VAULT_MASTER_KEY=hunter2hunter2")).not.toContain("hunter2");
    expect(redactLine("loaded media.signing: hunter2")).not.toContain("hunter2");
    expect(redactLine("token " + "A".repeat(40))).not.toContain("A".repeat(32));
  });

  it("json_stays_valid_json_when_secrets_are_removed", () => {
    const line = JSON.stringify({ msg: "hi", api_key: 12345, nested: { text: "Bearer abcdef1234567890abcdef", ok: 1 }, arr: ["sk-ant-api03-abcdefghijklmnopqrstuvwxyz"] });
    const out = redactLine(line);
    const parsed = JSON.parse(out);
    expect(parsed.msg).toBe("hi");
    expect(parsed.nested.ok).toBe(1);
    expect(out).not.toMatch(/abcdefghijklmnop|12345|abcdef1234567890/);
  });

  it("small_lines_untouched", () => {
    for (const l of ["stage draft started", "frame 12/300 rendered in 41ms", "video 0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b ready", "e=mc2 and s=1", '{"a":1,"b":"x"}', ""]) {
      expect(redactLine(l)).toBe(l);
    }
  });
});
