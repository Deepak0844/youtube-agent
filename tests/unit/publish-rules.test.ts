import { describe, expect, it } from "vitest";
import { liveHash } from "@/server/core/approvals";
import { MIN_PUBLISH_LEAD_MS, metadataProblem, publishAtProblem, publishLeadProblem, publishPolicyProblem, visibilityProblem } from "@/server/core/publish-rules";
import { sha256Hex } from "@/server/core/content-hash";

const NOW = Date.parse("2026-11-01T10:00:00Z");
const ok = { visibility: "private", publishAt: null, nowMs: NOW, allowPublic: false, requireEvidence: true, evidenceApproved: true, videoApproved: true } as const;

describe("visibility", () => {
  it("accepts exactly private, unlisted, public", () => {
    for (const v of ["private", "unlisted", "public"]) expect(visibilityProblem(v)).toBeNull();
    for (const v of ["Public", "PRIVATE", " public", "public ", "", "draft", null, undefined, 1, ["public"], { a: 1 }]) expect(visibilityProblem(v), String(v)).not.toBeNull();
  });
});

describe("publish_at format", () => {
  it("null means publish now and is valid", () => expect(publishAtProblem(null)).toBeNull());
  it("accepts ISO-8601 with an explicit zone", () => {
    for (const v of ["2026-11-02T10:00:00Z", "2026-11-02T10:00:00.123Z", "2026-11-02T15:30:00+05:30", "2026-11-02T10:00:00-00:00"]) expect(publishAtProblem(v), v).toBeNull();
  });
  it("refuses everything else, including real-looking impossible dates", () => {
    for (const v of ["", "tomorrow", "2026-11-02", "2026-11-02T10:00:00", "2026-11-02 10:00:00Z", "2026-02-30T10:00:00Z", "2026-13-01T10:00:00Z", "2026-11-02T25:00:00Z", "2026-11-02T10:60:00Z", "2026-11-02T10:00:00+24:00", "2026-11-02T10:00:00z", 1790000000, undefined, {}, [], "2026-11-02T10:00:00Z\n"]) {
      expect(publishAtProblem(v), String(v)).not.toBeNull();
    }
  });
});

describe("publish_at lead time", () => {
  it("needs at least 60 minutes ahead; null is fine", () => {
    expect(publishLeadProblem(null, NOW)).toBeNull();
    expect(publishLeadProblem(new Date(NOW + MIN_PUBLISH_LEAD_MS).toISOString(), NOW)).toBeNull();
    expect(publishLeadProblem(new Date(NOW + MIN_PUBLISH_LEAD_MS - 1).toISOString(), NOW)).not.toBeNull();
    expect(publishLeadProblem(new Date(NOW - 1000).toISOString(), NOW)).not.toBeNull();
  });
  it("compares instants, not text, so an offset cannot fake the lead", () => {
    expect(publishLeadProblem("2026-11-01T15:30:00+05:30", NOW)).not.toBeNull(); // 10:00Z = now
    expect(publishLeadProblem("2026-11-01T16:30:00+05:30", NOW)).toBeNull(); // 11:00Z
  });
});

describe("metadata", () => {
  it("needs an object with a valid visibility and publish_at", () => {
    expect(metadataProblem({ visibility: "private", publish_at: null })).toBeNull();
    expect(metadataProblem({ visibility: "private" })).toBeNull();
    expect(metadataProblem({ visibility: "world" })).not.toBeNull();
    expect(metadataProblem({ visibility: "private", publish_at: "soon" })).not.toBeNull();
    for (const b of [null, undefined, "x", 1, []]) expect(metadataProblem(b)).not.toBeNull();
  });
});

describe("publishPolicyProblem", () => {
  it("passes a private publish", () => expect(publishPolicyProblem({ ...ok })).toBeNull());
  it("public needs the kill switch to be exactly true (fail closed on anything else)", () => {
    expect(publishPolicyProblem({ ...ok, visibility: "public", allowPublic: true })).toBeNull();
    for (const v of [false, null, undefined, "true", 1, "yes"]) expect(publishPolicyProblem({ ...ok, visibility: "public", allowPublic: v }), String(v)).toMatch(/public/i);
  });
  it("private and unlisted do not need the kill switch", () => {
    expect(publishPolicyProblem({ ...ok, visibility: "unlisted" })).toBeNull();
  });
  it("evidence sign-off is required unless the policy is exactly false", () => {
    expect(publishPolicyProblem({ ...ok, evidenceApproved: false })).toMatch(/evidence/i);
    expect(publishPolicyProblem({ ...ok, evidenceApproved: false, requireEvidence: false })).toBeNull();
    for (const v of [undefined, null, "false", 0]) expect(publishPolicyProblem({ ...ok, evidenceApproved: false, requireEvidence: v }), String(v)).toMatch(/evidence/i);
  });
  it("the video itself must be approved first", () => {
    expect(publishPolicyProblem({ ...ok, videoApproved: false })).toMatch(/video/i);
  });
  it("at upload time the lead is not re-applied, but a time already in the past is refused", () => {
    const soon = new Date(NOW + 5 * 60_000).toISOString();
    expect(publishPolicyProblem({ ...ok, publishAt: soon, phase: "upload" })).toBeNull();
    expect(publishPolicyProblem({ ...ok, publishAt: soon })).toMatch(/60 minutes/);
    expect(publishPolicyProblem({ ...ok, publishAt: new Date(NOW - 1000).toISOString(), phase: "upload" })).toMatch(/passed/);
    expect(publishPolicyProblem({ ...ok, visibility: "public", phase: "upload" })).toMatch(/public/i);
  });
  it("applies the lead time and the field checks", () => {
    expect(publishPolicyProblem({ ...ok, publishAt: new Date(NOW + 30 * 60_000).toISOString() })).toMatch(/60 minutes/);
    expect(publishPolicyProblem({ ...ok, visibility: "everyone" })).not.toBeNull();
    expect(publishPolicyProblem({ ...ok, publishAt: "garbage" })).not.toBeNull();
  });
});

describe("the publish hash refuses malformed metadata", () => {
  const base = { video: { sha256: sha256Hex("v"), body: null, filePath: "videos/a/v.mp4" }, evidence: { sha256: sha256Hex("e"), body: null, filePath: "e.pdf" } };
  const hashFor = (meta: unknown) => liveHash("publish", { channelId: "UC1", content: { ...base, metadata: { sha256: sha256Hex("m"), body: meta } } });
  it("accepts a valid body", () => expect(hashFor({ visibility: "private", publish_at: null }).ok).toBe(true));
  it("refuses an unknown visibility value or a malformed publish_at", () => {
    expect(hashFor({ visibility: "world", publish_at: null }).ok).toBe(false);
    expect(hashFor({ visibility: "private", publish_at: "next tuesday" }).ok).toBe(false);
    expect(hashFor({ visibility: "private", publish_at: 12 }).ok).toBe(false);
  });
});

describe("the cost plan hash refuses malformed fields", () => {
  const plan = (over: Record<string, unknown>) => ({ providers_models: { llm: "m1" }, path: "scene_kit", library_scene_versions: { a: 1 }, quote: { micro_usd: "5" }, ...over });
  const hashFor = (body: unknown) => liveHash("cost", { channelId: null, content: { cost_plan: { sha256: sha256Hex("c"), body } } });
  it("accepts a valid plan", () => expect(hashFor(plan({})).ok).toBe(true));
  it("refuses a quote too large for a signed 64-bit amount, empty model names and bad scene versions", () => {
    expect(hashFor(plan({ quote: { micro_usd: "9".repeat(19) } })).ok).toBe(false);
    expect(hashFor(plan({ providers_models: { llm: "" } })).ok).toBe(false);
    expect(hashFor(plan({ providers_models: { llm: 5 } })).ok).toBe(false);
    expect(hashFor(plan({ library_scene_versions: { a: "1" } })).ok).toBe(false);
    expect(hashFor(plan({ library_scene_versions: { a: 0 } })).ok).toBe(false);
  });
});
