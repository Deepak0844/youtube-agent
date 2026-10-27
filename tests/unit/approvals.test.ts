import { describe, expect, it } from "vitest";
import { IMPLEMENTED_GATES, actorProblem, liveHash, noteProblem, type LiveInputs } from "@/server/core/approvals";
import { GATE_IDS } from "@/server/core/gates";

const SID = "11111111-1111-4111-8111-111111111111";
const h = (c: string) => c.repeat(64).slice(0, 64);
const plan = { providers_models: { llm: "m1" }, path: "scene_kit", library_scene_versions: { a: 1 }, quote: { micro_usd: "5" } };
const base = (): LiveInputs => ({
  channelId: "UC1",
  content: {
    script: { sha256: h("a"), body: { t: 1 } },
    cost_plan: { sha256: h("b"), body: plan },
    video: { sha256: h("c"), body: null },
    evidence: { sha256: h("d"), body: null },
    metadata: { sha256: h("e"), body: { visibility: "private", publish_at: null } },
  },
});
const hash = (g: (typeof IMPLEMENTED_GATES)[number], i: LiveInputs) => {
  const r = liveHash(g, i);
  if (!r.ok) throw new Error(r.reason);
  return r.hash;
};

describe("actorProblem", () => {
  it("accepts only {kind:'session'}", () => {
    expect(actorProblem({ kind: "session", sessionId: SID })).toBeNull();
    for (const bad of [undefined, null, {}, { kind: "session" }, { kind: "session", sessionId: "" }, { kind: "session", sessionId: "not-a-uuid" }, { kind: "session", sessionId: SID, extra: 1 }, { kind: "token", sessionId: SID }, { kind: "system" }, { kind: "job" }, "session", { kind: "Session", sessionId: SID }]) {
      expect(actorProblem(bad)).toBe("only the signed-in owner can do this");
    }
  });
});

describe("noteProblem", () => {
  it("needs 3 to 1000 non-blank characters", () => {
    expect(noteProblem("ab")).not.toBeNull();
    expect(noteProblem("   a  ")).not.toBeNull();
    expect(noteProblem("x".repeat(1001))).not.toBeNull();
    expect(noteProblem("fix the intro")).toBeNull();
    expect(noteProblem(42 as never)).not.toBeNull();
  });
  it("counts_code_points_not_utf16_units", () => {
    expect(noteProblem("😀".repeat(600))).toBeNull(); // 1200 UTF-16 units, 600 characters
    expect(noteProblem("😀".repeat(1000))).toBeNull();
    expect(noteProblem("😀".repeat(1001))).not.toBeNull();
    expect(noteProblem("😀😀😀")).toBeNull();
  });
  it("rejects_nul_control_characters_and_lone_surrogates_but_allows_newlines", () => {
    for (const bad of ["fix\u0000this", "bell\u0007here", "esc\u001bhere", "del\u007fhere", "lone\ud800surrogate"]) expect(noteProblem(bad), JSON.stringify(bad)).not.toBeNull();
    expect(noteProblem("line one\nline two\tok")).toBeNull();
  });
});

describe("liveHash", () => {
  it("is stable for equal inputs and refuses gates that are not built yet", () => {
    expect(hash("script", base())).toBe(hash("script", base()));
    for (const id of GATE_IDS.filter((g) => !(IMPLEMENTED_GATES as readonly string[]).includes(g))) {
      expect(liveHash(id, base())).toMatchObject({ ok: false });
    }
  });
  it("script, video and evidence follow only their own content", () => {
    for (const [g, k] of [["script", "script"], ["video", "video"], ["evidence", "evidence"]] as const) {
      const i = base();
      const before = hash(g, i);
      i.content[k] = { sha256: h("9"), body: i.content[k]!.body };
      expect(hash(g, i), g).not.toBe(before);
      const j = base();
      j.content.metadata = { sha256: h("8"), body: { visibility: "public", publish_at: null } };
      expect(hash(g, j), g).toBe(hash(g, base()));
    }
  });
  it("same_stored_sha_with_a_different_body_or_file_path_changes_the_hash", () => {
    for (const g of ["script", "video", "evidence", "publish"] as const) {
      const before = hash(g, base());
      const i = base();
      for (const k of ["script", "video", "evidence", "metadata"] as const) {
        const c = i.content[k]!;
        i.content[k] = { sha256: c.sha256, body: c.body === null ? null : { ...(c.body as object), tampered: true }, filePath: c.body === null ? "other/path.bin" : null };
      }
      expect(hash(g, i), g).not.toBe(before);
    }
    const a = base();
    a.content.video = { sha256: h("c"), body: null, filePath: "v/1.mp4" };
    const b = base();
    b.content.video = { sha256: h("c"), body: null, filePath: "v/2.mp4" };
    expect(hash("video", a)).not.toBe(hash("video", b));
  });
  it("cost_refuses_null_or_wrongly_shaped_plan_fields", () => {
    const bad: Array<Record<string, unknown>> = [
      { providers_models: null, path: null, library_scene_versions: null, quote: null },
      { ...plan, providers_models: null },
      { ...plan, providers_models: {} },
      { ...plan, path: "teleport" },
      { ...plan, path: null },
      { ...plan, library_scene_versions: null },
      { ...plan, library_scene_versions: [] },
      { ...plan, quote: null },
      { ...plan, quote: { micro_usd: 5 } },
      { ...plan, quote: { micro_usd: "-5" } },
      { ...plan, quote: {} },
    ];
    for (const b of bad) {
      const i = base();
      i.content.cost_plan = { sha256: h("b"), body: b };
      expect(liveHash("cost", i), JSON.stringify(b)).toMatchObject({ ok: false });
    }
  });
  it("unreadable_content_refuses_instead_of_throwing", () => {
    const i = base();
    i.content.script = { sha256: h("a"), body: { f: () => 1 } };
    expect(liveHash("script", i)).toMatchObject({ ok: false });
  });
  it("missing content refuses with a plain reason", () => {
    const i = base();
    delete i.content.script;
    expect(liveHash("script", i)).toEqual({ ok: false, reason: expect.stringMatching(/nothing to approve/) });
  });
  it("cost_hash_covers_quote_providers_path_and_library_scene_versions", () => {
    const before = hash("cost", base());
    const changed = { providers_models: { llm: "m2" }, path: "ai", library_scene_versions: { a: 2 }, quote: { micro_usd: "6" } };
    for (const field of ["providers_models", "path", "library_scene_versions", "quote"] as const) {
      const i = base();
      i.content.cost_plan = { sha256: h("b"), body: { ...plan, [field]: changed[field] } }; // same stored sha: the field itself is covered
      expect(hash("cost", i), field).not.toBe(before);
    }
    const i = base();
    i.content.cost_plan = { sha256: h("7"), body: plan };
    expect(hash("cost", i)).not.toBe(before);
  });
  it("cost refuses an incomplete or file-backed plan", () => {
    const i = base();
    i.content.cost_plan = { sha256: h("b"), body: { path: "x" } };
    expect(liveHash("cost", i)).toMatchObject({ ok: false });
    i.content.cost_plan = { sha256: h("b"), body: null };
    expect(liveHash("cost", i)).toMatchObject({ ok: false });
  });
  it("publish_hash_covers_evidence_channel_visibility_and_publish_at", () => {
    const before = hash("publish", base());
    const edits: Array<[string, (i: LiveInputs) => void]> = [
      ["video", (i) => void (i.content.video = { sha256: h("1"), body: null })],
      ["metadata", (i) => void (i.content.metadata = { sha256: h("2"), body: i.content.metadata!.body })],
      ["evidence", (i) => void (i.content.evidence = { sha256: h("3"), body: null })],
      ["channel", (i) => void (i.channelId = "UC2")],
      ["visibility", (i) => void (i.content.metadata = { sha256: h("e"), body: { visibility: "public", publish_at: null } })],
      ["publish_at", (i) => void (i.content.metadata = { sha256: h("e"), body: { visibility: "private", publish_at: "2030-01-01T00:00:00Z" } })],
    ];
    for (const [name, edit] of edits) {
      const i = base();
      edit(i);
      expect(hash("publish", i), name).not.toBe(before);
    }
  });
  it("publish refuses when channel, visibility or any part is missing", () => {
    const a = base();
    a.channelId = null;
    expect(liveHash("publish", a)).toMatchObject({ ok: false });
    const b = base();
    b.content.metadata = { sha256: h("e"), body: { publish_at: null } };
    expect(liveHash("publish", b)).toMatchObject({ ok: false });
    const c = base();
    delete c.content.evidence;
    expect(liveHash("publish", c)).toMatchObject({ ok: false });
  });
});
