import { describe, expect, it } from "vitest";
import { moneyAnomalies, pickVoice, parseSmokeArgs, planSmoke, redactFixture, refuseEnvironment, SmokeRefusal, type Candidate } from "@/server/core/smoke-plan";

const cand = (o: Partial<Candidate> & { id: string }): Candidate => ({ provider: "elevenlabs", label: o.id, quoteMicro: 3200, needsKey: true, ...o });
const base = { selected: new Set(["elevenlabs", "pixabay"]), haveKey: () => true, capMicro: 500_000, interactive: true, yesSpend: false, allowanceChars: null };

describe("smoke plan", () => {
  it("plan_refuses_over_cap", () => {
    expect(() => parseSmokeArgs(["--cap", "2.01"])).toThrow(SmokeRefusal);
    expect(parseSmokeArgs(["--cap", "2"]).capUsd).toBe(2);
    expect(parseSmokeArgs([]).capUsd).toBe(0.5);
    expect(() => planSmoke({ ...base, capMicro: 100_000, candidates: [cand({ id: "sfx", quoteMicro: 120_000 })] })).toThrow(SmokeRefusal);
  });

  it("skips a call bigger than the remaining cap with a message and runs the rest", () => {
    const p = planSmoke({ ...base, capMicro: 100_000, candidates: [cand({ id: "sfx", quoteMicro: 120_000 }), cand({ id: "v", quoteMicro: 3200 })] });
    expect(p.calls.map((c) => c.id)).toEqual(["v"]);
    expect(p.skipped[0]!.why).toBe("skipped: sfx quote $0.12 exceeds the remaining cap $0.10");
  });

  it("dry plan needs no terminal and no yes flag", () => {
    expect(planSmoke({ ...base, interactive: false, dryPlan: true, candidates: [cand({ id: "v" })] }).calls).toHaveLength(1);
  });

  it("drops an optional call that does not fit the cap", () => {
    const p = planSmoke({ ...base, capMicro: 200_000, candidates: [cand({ id: "sfx", quoteMicro: 120_000 }), cand({ id: "music", quoteMicro: 150_000, optional: true })] });
    expect(p.calls.map((c) => c.id)).toEqual(["sfx"]);
    expect(p.skipped[0]!.why).toMatch(/cap/);
  });

  it("plan_requires_yes_flag_when_not_interactive", () => {
    const candidates = [cand({ id: "v" })];
    expect(() => planSmoke({ ...base, interactive: false, candidates })).toThrow(/--yes-spend/);
    expect(planSmoke({ ...base, interactive: false, yesSpend: true, candidates }).calls).toHaveLength(1);
    expect(planSmoke({ ...base, interactive: false, candidates: [cand({ id: "s", provider: "pixabay", quoteMicro: 0, needsKey: true })] }).calls).toHaveLength(1);
  });

  it("lists a call only for selected providers with a key", () => {
    const p = planSmoke({ ...base, selected: new Set(["elevenlabs", "pixabay"]), haveKey: (x) => x !== "pixabay", candidates: [cand({ id: "v" }), cand({ id: "s", provider: "pixabay", quoteMicro: 0 }), cand({ id: "e", provider: "edge", needsKey: false, quoteMicro: 0 })] });
    expect(p.calls.map((c) => c.id)).toEqual(["v"]);
    expect(p.skipped).toEqual([{ id: "s", why: expect.stringMatching(/no pixabay key/i) }]);
  });

  it("skips a call the ElevenLabs allowance cannot cover", () => {
    const p = planSmoke({ ...base, allowanceChars: 50, candidates: [cand({ id: "a", chars: 40 }), cand({ id: "b", chars: 40 })] });
    expect(p.calls.map((c) => c.id)).toEqual(["a"]);
    expect(p.skipped[0]!.why).toMatch(/allowance/);
  });

  it("refuses a non-local database and a production env", () => {
    expect(() => refuseEnvironment({ DATABASE_URL: "postgres://u:p@db.example.com:5432/x" })).toThrow(SmokeRefusal);
    expect(() => refuseEnvironment({})).toThrow(SmokeRefusal);
    expect(() => refuseEnvironment({ DATABASE_URL: "postgres://u:p@127.0.0.1:5432/x", NODE_ENV: "production" })).toThrow(SmokeRefusal);
    expect(() => refuseEnvironment({ DATABASE_URL: "postgres://u:p@localhost:5432/x", NODE_ENV: "development" })).not.toThrow();
  });

  it("flags a recorded price above the quote or a total above the cap", () => {
    expect(moneyAnomalies(500_000, [{ id: "a", quoteMicro: 100, recordedMicro: 100 }])).toEqual([]);
    expect(moneyAnomalies(500_000, [{ id: "a", quoteMicro: 100, recordedMicro: 101 }])).toHaveLength(1);
    expect(moneyAnomalies(500_000, [{ id: "a", quoteMicro: 100, recordedMicro: 99 }])).toHaveLength(1);
    expect(moneyAnomalies(500_000, [{ id: "a", quoteMicro: 100, recordedMicro: 0, failed: true }])).toEqual([]);
    expect(moneyAnomalies(150, [{ id: "a", quoteMicro: 100, recordedMicro: 100 }, { id: "b", quoteMicro: 100, recordedMicro: 100 }])).toHaveLength(1);
  });
});

describe("fixtures", () => {
  it("secrets_stripped_from_recorded_fixtures", () => {
    const key = "12345678-abcdef0123456789abcdef01";
    const raw = `{"a":1}\nAuthorization: Bearer abcdefghijklmnop1234\nxi-api-key: sk_0123456789abcdef0123456789\nurl=https://pixabay.com/api/?key=${key}&q=cat\n${key}`;
    const out = redactFixture(raw, [key]);
    for (const s of [key, "abcdefghijklmnop1234", "sk_0123456789abcdef0123456789"]) expect(out).not.toContain(s);
    expect(out).toContain('{"a":1}');
  });
});

describe("voice choice", () => {
  it("prefers the account's own voices and never a library one", () => {
    const v = (voice_id: string, category: string) => ({ voice_id, category });
    expect(pickVoice([v("lib1", "professional_library"), v("pre1", "premade"), v("gen1", "generated")])).toBe("gen1");
    expect(pickVoice([v("lib1", "famous"), v("pre1", "premade")])).toBe("pre1");
    expect(pickVoice([v("lib1", "famous")])).toBeNull();
    expect(pickVoice(undefined)).toBeNull();
  });
});
