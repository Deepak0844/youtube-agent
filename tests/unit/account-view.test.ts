import { describe, expect, it } from "vitest";
import { changePasswordMessage, deviceLabel, MAX_PASSWORD_INPUT, passwordFormProblem } from "@/server/core/account-view";

const GOOD = "correct horse battery 9";
describe("passwordFormProblem", () => {
  it("accepts a good change", () => expect(passwordFormProblem("old password here", GOOD, GOOD, "owner")).toBeNull());
  it("asks for what is missing, in order", () => {
    expect(passwordFormProblem("", GOOD, GOOD, "owner")).toBe("Enter your current password.");
    expect(passwordFormProblem("old password here", "", "", "owner")).toBe("Enter a new password.");
  });
  it("catches a mismatch, the same password, a short one, a common one and the username", () => {
    expect(passwordFormProblem("old password here", GOOD, `${GOOD}x`, "owner")).toBe("The two new passwords are not the same.");
    expect(passwordFormProblem(GOOD, GOOD, GOOD, "owner")).toMatch(/same as the current/);
    expect(passwordFormProblem("old password here", "short", "short", "owner")).toBe("Use at least 12 characters.");
    expect(passwordFormProblem("old password here", "password1234", "password1234", "owner")).toMatch(/too common/);
    expect(passwordFormProblem("old password here", "someone-else-1", "someone-else-1", "someone-else-1")).toMatch(/username/);
  });
  it("refuses an over-long input without echoing it", () => {
    const long = "x".repeat(MAX_PASSWORD_INPUT + 1);
    const p = passwordFormProblem("old password here", long, long, "owner");
    expect(p).toBe("That password is too long.");
  });
  it("never repeats what was typed", () => {
    for (const [c, n, a] of [["secret-current-1", "n1", "n1"], ["secret-current-1", GOOD, "other-one-12345"]] as const) {
      const p = passwordFormProblem(c, n, a, "owner") ?? "";
      expect(p).not.toContain("secret-current");
      expect(p).not.toContain(GOOD);
    }
  });
});

describe("changePasswordMessage", () => {
  it("has a fixed sentence for every refusal and none of them say the password", () => {
    for (const r of ["invalid", "weak_password", "locked", "busy"] as const) {
      const m = changePasswordMessage(r);
      expect(m.length).toBeGreaterThan(10);
      expect(m).not.toMatch(/password is "|:\s*\S+@/);
    }
    expect(changePasswordMessage("invalid")).toMatch(/Nothing was changed/);
  });
});

describe("deviceLabel", () => {
  it("names the browser and system, and never the whole user-agent text", () => {
    expect(deviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36")).toBe("Chrome on Mac");
    expect(deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1")).toBe("Safari on iPhone or iPad");
    expect(deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Gecko/20100101 Firefox/133.0")).toBe("Firefox on Windows");
    expect(deviceLabel("curl/8.4.0")).toBe("curl");
    expect(deviceLabel(null)).toBe("Unknown browser");
    expect(deviceLabel("<script>alert(1)</script>")).toBe("Unknown browser");
  });
});
