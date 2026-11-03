import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type pg from "pg";
import { describe, expect, it } from "vitest";
import { channelSettingsSchema, channelUploadProblem } from "@/server/core/channel-safety";
import { parsePolicy, POLICY_DEFAULTS } from "@/server/core/policy";
import { loadPolicy } from "@/server/db/policy-file";
import { saveUploadSwitches } from "@/server/db/system-settings";
import { saveChannelSettings } from "@/server/db/youtube-channels";

const ch = { production: false, allowPublic: false, status: "connected" };
const base = { killSwitch: false, cutoverDone: false, visibility: "private", channel: ch };

describe("channelUploadProblem", () => {
  it("allows a private upload on a plain channel", () => expect(channelUploadProblem(base)).toBeNull());
  it("kill switch refuses everything, also for an unknown channel; only a stored false is off", () => {
    expect(channelUploadProblem({ ...base, killSwitch: true })).toMatch(/kill switch/);
    expect(channelUploadProblem({ ...base, killSwitch: true, channel: null })).toMatch(/kill switch/);
    for (const v of [undefined, null, "false", 0]) expect(channelUploadProblem({ ...base, killSwitch: v })).toMatch(/kill switch/);
  });
  it("a channel with no row, or one not confirmed and connected, is refused", () => {
    expect(channelUploadProblem({ ...base, channel: null })).toMatch(/not connected/);
    for (const status of ["unconfirmed", "needs_reconnect", "", "weird"]) expect(channelUploadProblem({ ...base, channel: { ...ch, status } })).toMatch(/connect/);
  });
  it("public needs the channel's allow_public", () => {
    expect(channelUploadProblem({ ...base, visibility: "public" })).toMatch(/public/);
    expect(channelUploadProblem({ ...base, visibility: "public", channel: { ...ch, allowPublic: true } })).toBeNull();
    expect(channelUploadProblem({ ...base, visibility: "unlisted" })).toBeNull();
  });
  it("a production channel waits for the cutover (only true opens it)", () => {
    const prod = { ...base, channel: { ...ch, production: true } };
    expect(channelUploadProblem(prod)).toMatch(/cutover/);
    expect(channelUploadProblem({ ...prod, cutoverDone: "true" })).toMatch(/cutover/);
    expect(channelUploadProblem({ ...prod, cutoverDone: true })).toBeNull();
  });
});

describe("policy", () => {
  it("has the cautious defaults", () => {
    expect(POLICY_DEFAULTS).toMatchObject({ defaultVisibility: "private", maxUploadsPerDay: 2, minHoursBetweenUploads: 6, quotaBudget: 8000, minScheduleLeadMinutes: 60, repliesPerDay: 10, secondsBetweenReplies: 90 });
  });
  it("takes valid numbers from the file and ignores bad fields and visibility", () => {
    expect(parsePolicy({ maxUploadsPerDay: 1, quotaBudget: "9", repliesPerDay: -1, defaultVisibility: "public" })).toEqual({ ...POLICY_DEFAULTS, maxUploadsPerDay: 1 });
    expect(parsePolicy({ quotaBudget: 50_000 }).quotaBudget).toBe(10_000);
    expect(parsePolicy(null)).toEqual(POLICY_DEFAULTS);
    expect(parsePolicy([1])).toEqual(POLICY_DEFAULTS);
  });
  it("loadPolicy: missing or broken file gives the defaults; a good file overrides", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "policy-"));
    try {
      expect(loadPolicy(path.join(dir, "none.json"))).toEqual(POLICY_DEFAULTS);
      writeFileSync(path.join(dir, "bad.json"), "{nope");
      expect(loadPolicy(path.join(dir, "bad.json"))).toEqual(POLICY_DEFAULTS);
      writeFileSync(path.join(dir, "ok.json"), JSON.stringify({ quotaBudget: 5000 }));
      expect(loadPolicy(path.join(dir, "ok.json")).quotaBudget).toBe(5000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// A pool that fails loudly on any use: the refusal must happen BEFORE the database is touched.
const untouchable = (): pg.Pool => {
  const boom = () => {
    throw new Error("DB TOUCHED");
  };
  return { connect: boom, query: boom } as unknown as pg.Pool;
};
const input = { production: false, allowPublic: true, madeForKids: false, synthetic: false, maxUploadsPerDay: 2, minHoursBetweenUploads: 6, language: "en", categoryId: 27, defaultStyle: null };

describe("human gate: switches change only for the owner session", () => {
  it("saveChannelSettings refuses any actor that is not exactly a session, before touching the database", async () => {
    const sid = "11111111-1111-4111-8111-111111111111";
    for (const actor of [{ kind: "token", sessionId: sid }, { kind: "system" }, { kind: "job" }, { kind: "session" }, { kind: "session", sessionId: "x" }, { kind: "session", sessionId: sid, extra: 1 }, "session", null, undefined]) {
      await expect(saveChannelSettings(untouchable(), "id", input, actor as never)).resolves.toMatchObject({ ok: false });
    }
  });
  it("the typed phrase is checked before the database is touched", async () => {
    for (const typed of [undefined, "", "go live", "GO LIVE ", "GO  LIVE"]) {
      await expect(saveUploadSwitches(untouchable(), { cutover: true, typed })).resolves.toMatchObject({ ok: false });
    }
  });
  it("made for kids must be stated: the schema has no default", () => {
    expect(channelSettingsSchema.safeParse({ ...input, madeForKids: undefined }).success).toBe(false);
    expect(channelSettingsSchema.safeParse(input).success).toBe(true);
    expect(channelSettingsSchema.safeParse({ ...input, defaultStyle: "legacy_default" }).success).toBe(false);
  });
});
