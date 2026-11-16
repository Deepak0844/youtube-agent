import { describe, expect, it } from "vitest";
import { INIT_STEPS, refuseInit, stepOutcome } from "@/server/core/compose-setup";

const good = { POSTGRES_PASSWORD: "p".repeat(20), YTSTUDIO_OWNER_PASSWORD: "o".repeat(20), YTSTUDIO_APP_PASSWORD: "a".repeat(20), YTSTUDIO_BACKUP_PASSWORD: "b".repeat(20), VAULT_MASTER_KEY: "k".repeat(44) };

describe("compose first-run setup", () => {
  it("accepts real secrets", () => expect(refuseInit(good)).toBeNull());
  it("refuses CHANGE_ME or missing secrets, naming the first one", () => {
    expect(refuseInit({ ...good, YTSTUDIO_OWNER_PASSWORD: "CHANGE_ME" })).toBe("Set real passwords in .env: YTSTUDIO_OWNER_PASSWORD is still CHANGE_ME.");
    expect(refuseInit({ ...good, POSTGRES_PASSWORD: undefined })).toBe("Set real passwords in .env: POSTGRES_PASSWORD is missing.");
    expect(refuseInit({ ...good, VAULT_MASTER_KEY: "" })).toBe("Set real passwords in .env: VAULT_MASTER_KEY is missing.");
    expect(refuseInit({ ...good, YTSTUDIO_BACKUP_PASSWORD: undefined })).toBe("Set real passwords in .env: YTSTUDIO_BACKUP_PASSWORD is missing.");
    expect(refuseInit({})).toContain("POSTGRES_PASSWORD");
  });
  it("refuses a password that would break a database URL, naming it", () => {
    for (const bad of ["p@ss-word-long-enough", "pass/word", "pass:word", "pass word", "päss"]) {
      expect(refuseInit({ ...good, YTSTUDIO_APP_PASSWORD: bad }), bad).toBe("YTSTUDIO_APP_PASSWORD in .env may only use letters, digits and - _ . ~ (it goes into a database address).");
    }
    expect(refuseInit({ ...good, YTSTUDIO_APP_PASSWORD: "Abc-123_x.y~z" })).toBeNull();
  });
  it("runs bootstrap, migrate, the sound library import, owner:create in that order", () => expect(INIT_STEPS).toEqual(["db:bootstrap", "db:migrate", "audio:import", "owner:create"]));
  it("an existing owner is a skip; any other owner:create failure is a fail", () => {
    expect(stepOutcome("owner:create", 1, "An owner already exists. Use `npm run owner:reset` to recover access.\n")).toBe("skip");
    expect(stepOutcome("owner:create", 1, "APP_URL must be an http(s) URL")).toBe("fail");
    expect(stepOutcome("owner:create", 0, "")).toBe("ok");
  });
  it("bootstrap, migrate and the sound import: zero is ok, anything else is fail (an 'already exists' text does not rescue them)", () => {
    for (const s of ["db:bootstrap", "db:migrate", "audio:import"] as const) {
      expect(stepOutcome(s, 0, "")).toBe("ok");
      expect(stepOutcome(s, 1, "An owner already exists.")).toBe("fail");
    }
  });
});
