import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "@/server/core/content-hash";
import { approvalState, approveGate, isApproved, liveGateHash, sendBack } from "@/server/db/approvals";
import { addContent } from "@/server/db/videos";
import { withTestDb, type TestDb } from "../support/db";
import { SESSION_ID, STALE, bumpContent, seedVideo } from "../support/gate-fixture";

let db: TestDb;
beforeAll(async () => {
  db = await withTestDb();
});
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  await db.ownerPool.query("drop trigger if exists boom on audit_log");
  await db.ownerPool.query("truncate videos, video_content, approvals, audit_log cascade");
});
const session = { kind: "session", sessionId: SESSION_ID } as const;
const live = async (v: string, gate: "script" | "publish" | "cost" | "video" | "evidence" = "script") => (await liveGateHash(db.pool, v, gate))!.hash;
const approve = async (v: string, seenHash: string, gate: "script" | "publish" | "cost" | "video" | "evidence" = "script") => approveGate(db.pool, { videoId: v, gate, seenHash, actor: session });

describe("approvals", () => {
  it("approval_valid_only_while_stored_hash_equals_live_hash", async () => {
    const v = await seedVideo(db.pool);
    expect(await isApproved(db.pool, v, "script")).toBe(false);
    const r = await approve(v, await live(v));
    expect(r).toMatchObject({ ok: true });
    expect(await isApproved(db.pool, v, "script")).toBe(true);
    await bumpContent(db.pool, v, "script");
    expect(await isApproved(db.pool, v, "script")).toBe(false);
    expect(await isApproved(db.pool, v, "video")).toBe(false);
  });
  it("a_change_to_an_uncovered_kind_keeps_the_approval", async () => {
    const v = await seedVideo(db.pool);
    await approve(v, await live(v));
    await bumpContent(db.pool, v, "metadata");
    expect(await isApproved(db.pool, v, "script")).toBe(true);
  });
  it("approving_again_after_a_rewrite_makes_it_valid_again_and_the_old_hash_stays_dead", async () => {
    const v = await seedVideo(db.pool);
    const h1 = await live(v);
    await approve(v, h1);
    await bumpContent(db.pool, v, "script");
    expect(await approve(v, h1)).toMatchObject({ ok: false, reason: expect.stringMatching(/changed while you were looking/) });
    expect(await isApproved(db.pool, v, "script")).toBe(false);
    expect(await approve(v, await live(v))).toMatchObject({ ok: true });
    expect(await isApproved(db.pool, v, "script")).toBe(true);
  });
  it("send_back_makes_the_gate_not_approved_and_stores_the_note", async () => {
    const v = await seedVideo(db.pool);
    const h = await live(v);
    await approve(v, h);
    const r = await sendBack(db.pool, { videoId: v, gate: "script", seenHash: h, note: "intro is too long", actor: session });
    expect(r).toMatchObject({ ok: true });
    expect(await isApproved(db.pool, v, "script")).toBe(false);
    const rows = (await db.pool.query("select decision, note, decided_by from approvals where video_id = $1 order by seq", [v])).rows;
    expect(rows).toEqual([
      { decision: "approved", note: null, decided_by: "session" },
      { decision: "sent_back", note: "intro is too long", decided_by: "session" },
    ]);
  });
  it("sent_back_version_cannot_be_approved_with_its_old_hash_after_rewrite", async () => {
    const v = await seedVideo(db.pool);
    const h1 = await live(v);
    await sendBack(db.pool, { videoId: v, gate: "script", seenHash: h1, note: "needs work", actor: session });
    expect(await approve(v, h1)).toMatchObject({ ok: false, reason: expect.stringMatching(/sent this back/) }); // same content
    await bumpContent(db.pool, v, "script");
    expect(await approve(v, h1)).toMatchObject({ ok: false });
    expect(await isApproved(db.pool, v, "script")).toBe(false);
    expect(await approve(v, await live(v))).toMatchObject({ ok: true });
  });
  it("send_back_needs_a_real_note_and_the_current_hash", async () => {
    const v = await seedVideo(db.pool);
    const h = await live(v);
    for (const note of ["", "  a ", "ab", "x".repeat(1001)]) {
      expect(await sendBack(db.pool, { videoId: v, gate: "script", seenHash: h, note, actor: session })).toMatchObject({ ok: false });
    }
    expect(await sendBack(db.pool, { videoId: v, gate: "script", seenHash: STALE, note: "fine note", actor: session })).toMatchObject({ ok: false });
    expect((await db.pool.query("select count(*)::int n from approvals")).rows[0].n).toBe(0);
  });
  it("refuses_other_actors_missing_actor_unknown_video_unbuilt_gates_and_malformed_hashes", async () => {
    const v = await seedVideo(db.pool);
    const h = await live(v);
    for (const actor of [undefined, null, {}, { kind: "session" }, { kind: "session", sessionId: "" }, { kind: "session", sessionId: "nope" }, { kind: "token", sessionId: SESSION_ID }, { kind: "system" }, { kind: "job" }, { kind: "session", sessionId: SESSION_ID, extra: 1 }]) {
      expect(await approveGate(db.pool, { videoId: v, gate: "script", seenHash: h, actor: actor as never })).toEqual({ ok: false, reason: "only the signed-in owner can do this" });
      expect(await sendBack(db.pool, { videoId: v, gate: "script", seenHash: h, note: "valid note", actor: actor as never })).toEqual({ ok: false, reason: "only the signed-in owner can do this" });
    }
    expect(await approveGate(db.pool, { videoId: "00000000-0000-4000-8000-000000000000", gate: "script", seenHash: h, actor: session })).toMatchObject({ ok: false });
    expect(await approveGate(db.pool, { videoId: "not-a-uuid", gate: "script", seenHash: h, actor: session })).toMatchObject({ ok: false });
    for (const gate of ["outline", "chapter", "thumbnail", "comment_reply", "allow_public", "live_title", "nope"]) {
      expect(await approveGate(db.pool, { videoId: v, gate: gate as never, seenHash: h, actor: session })).toMatchObject({ ok: false });
    }
    for (const seenHash of ["", "abc", h.toUpperCase(), `${h}0`, null as never]) {
      expect(await approve(v, seenHash)).toMatchObject({ ok: false });
    }
    expect((await db.pool.query("select count(*)::int n from approvals")).rows[0].n).toBe(0);
    expect((await db.pool.query("select count(*)::int n from audit_log where event like 'gate.%'")).rows[0].n).toBe(0);
  });
  it("missing_content_refuses_instead_of_hashing_nothing", async () => {
    const v = (await db.pool.query("insert into videos (format, kind, language, topic) values ('short','ai','en','t') returning id")).rows[0].id;
    expect(await liveGateHash(db.pool, v, "script")).toBeNull();
    expect(await approve(v, STALE)).toMatchObject({ ok: false, reason: expect.stringMatching(/nothing to approve/) });
  });
  it("publish_follows_the_channel_on_the_video_row", async () => {
    const v = await seedVideo(db.pool);
    const h = await live(v, "publish");
    await approve(v, h, "publish");
    expect(await isApproved(db.pool, v, "publish")).toBe(true);
    await db.pool.query("update videos set channel_id = 'UC2' where id = $1", [v]);
    expect(await isApproved(db.pool, v, "publish")).toBe(false);
  });
  it("publish_voids_when_metadata_visibility_or_publish_at_change", async () => {
    for (const body of [{ visibility: "public", publish_at: null }, { visibility: "private", publish_at: "2030-01-01T00:00:00Z" }]) {
      const v = await seedVideo(db.pool);
      await approve(v, await live(v, "publish"), "publish");
      await addContent(db.pool, v, "metadata", { body, sha256: sha256Hex("meta-1") }); // same stored sha, different fields
      expect(await isApproved(db.pool, v, "publish"), JSON.stringify(body)).toBe(false);
    }
  });
  it("cost_voids_when_a_plan_field_changes_even_with_the_same_stored_sha", async () => {
    const v = await seedVideo(db.pool);
    await approve(v, await live(v, "cost"), "cost");
    const plan = { providers_models: { llm: "m2" }, path: "scene_kit", library_scene_versions: { a: 1 }, quote: { micro_usd: "5" } };
    await addContent(db.pool, v, "cost_plan", { body: plan, sha256: sha256Hex("plan-1") });
    expect(await isApproved(db.pool, v, "cost")).toBe(false);
  });

  it("approve_and_rewrite_race_never_leaves_a_valid_approval_for_unseen_content", async () => {
    // Barrier: the test holds the video row lock, so both the approve and the worker's rewrite (its insert takes a key-share
    // lock on the same row) queue behind it. Whichever the database runs first, no approval may be valid afterwards.
    for (const order of ["approve_first", "rewrite_first"] as const) {
      const v = await seedVideo(db.pool);
      const seen = await live(v);
      const lock = await db.pool.connect();
      await lock.query("begin");
      await lock.query("select id from videos where id = $1 for update", [v]);
      let approveP: Promise<unknown>;
      let rewriteP: Promise<unknown>;
      if (order === "approve_first") {
        approveP = approve(v, seen);
        await new Promise((r) => setTimeout(r, 200));
        rewriteP = bumpContent(db.pool, v, "script");
      } else {
        rewriteP = bumpContent(db.pool, v, "script");
        await new Promise((r) => setTimeout(r, 200));
        approveP = approve(v, seen);
      }
      await new Promise((r) => setTimeout(r, 200)); // both are blocked behind the lock
      await lock.query("commit");
      lock.release();
      const [ar] = await Promise.all([approveP as Promise<{ ok: boolean; reason?: string }>, rewriteP]);
      expect(await isApproved(db.pool, v, "script"), order).toBe(false);
      if (order === "rewrite_first") expect(ar).toMatchObject({ ok: false, reason: expect.stringMatching(/changed while you were looking/) });
    }
    // Rewrite fully committed before the approve: refused. Approve committed before the rewrite: voided at once.
    const v1 = await seedVideo(db.pool);
    const seen1 = await live(v1);
    await bumpContent(db.pool, v1, "script");
    expect(await approve(v1, seen1)).toMatchObject({ ok: false });
    const v2 = await seedVideo(db.pool);
    expect(await approve(v2, await live(v2))).toMatchObject({ ok: true });
    await bumpContent(db.pool, v2, "script");
    expect(await isApproved(db.pool, v2, "script")).toBe(false);
  });
  it("many_concurrent_approves_and_rewrites_never_validate_unseen_content", async () => {
    for (let round = 0; round < 8; round++) {
      const v = await seedVideo(db.pool);
      const seen = await live(v);
      const results = await Promise.all([approve(v, seen), bumpContent(db.pool, v, "script"), approve(v, seen), bumpContent(db.pool, v, "script")]);
      const valid = await isApproved(db.pool, v, "script");
      expect(valid, `round ${round}`).toBe(false); // two rewrites landed, so no stored hash equals the live one
      for (const r of [results[0], results[2]]) if (r && typeof r === "object" && "ok" in r && r.ok) expect(valid).toBe(false);
    }
  });

  it("approvals_table_rejects_update_and_delete_for_app_role", async () => {
    const v = await seedVideo(db.pool);
    await approve(v, await live(v));
    const denied = { code: "42501" };
    await expect(db.pool.query("update approvals set decision = 'sent_back'")).rejects.toMatchObject(denied);
    await expect(db.pool.query("delete from approvals")).rejects.toMatchObject(denied);
    await expect(db.pool.query("truncate approvals")).rejects.toMatchObject(denied);
    await expect(db.pool.query("insert into approvals (video_id, gate, content_hash, content_versions, decision, decided_by, session_id) values ($1,'script',$2,'{}'::jsonb,'approved','token',$3)", [v, STALE, SESSION_ID])).rejects.toThrow(/check/);
    await expect(db.pool.query("insert into approvals (video_id, gate, content_hash, content_versions, decision, note, decided_by, session_id) values ($1,'script',$2,'{}'::jsonb,'sent_back',null,'session',$3)", [v, STALE, SESSION_ID])).rejects.toThrow(/check/);
  });
  it("a_failed_insert_leaves_no_partial_approval", async () => {
    const v = await seedVideo(db.pool);
    const h = await live(v);
    await db.ownerPool.query("create or replace function boom_fn() returns trigger language plpgsql as $$ begin raise exception 'audit down'; end $$");
    await db.ownerPool.query("create trigger boom before insert on audit_log for each row execute function boom_fn()");
    try {
      await expect(approve(v, h)).rejects.toThrow(/audit down/);
      await expect(sendBack(db.pool, { videoId: v, gate: "script", seenHash: h, note: "some note", actor: session })).rejects.toThrow(/audit down/);
    } finally {
      await db.ownerPool.query("drop trigger boom on audit_log");
    }
    expect((await db.pool.query("select count(*)::int n from approvals")).rows[0].n).toBe(0);
    expect(await isApproved(db.pool, v, "script")).toBe(false);
  });
  it("audit_rows_carry_ids_and_a_short_prefix_never_content_or_notes", async () => {
    const v = await seedVideo(db.pool);
    const h = await live(v);
    await approve(v, h);
    await sendBack(db.pool, { videoId: v, gate: "script", seenHash: h, note: "secret-ish note text", actor: session });
    const rows = (await db.pool.query("select event, detail from audit_log where event like 'gate.%' order by id")).rows;
    expect(rows.map((r) => r.event)).toEqual(["gate.approved", "gate.sent_back"]);
    for (const r of rows) {
      expect(r.detail).toEqual({ videoId: v, gate: "script", hashPrefix: h.slice(0, 8), sessionId: SESSION_ID });
      expect(JSON.stringify(r.detail)).not.toContain("note text");
    }
  });

  it("same_stored_sha_with_a_different_body_or_file_path_voids_the_approval_for_every_gate", async () => {
    for (const [gate, kind] of [["script", "script"], ["video", "video"], ["evidence", "evidence"], ["publish", "metadata"], ["publish", "video"]] as const) {
      const v = await seedVideo(db.pool);
      const prev = (await db.pool.query("select sha256 from video_content where video_id = $1 and kind = $2 order by version desc limit 1", [v, kind])).rows[0].sha256;
      expect(await approve(v, await live(v, gate), gate)).toMatchObject({ ok: true });
      if (kind === "video" || kind === "evidence") await addContent(db.pool, v, kind, { filePath: "swapped/other.bin", sha256: prev });
      else await addContent(db.pool, v, kind, { body: { visibility: "public", publish_at: null, text: "swapped" }, sha256: prev });
      expect(await isApproved(db.pool, v, gate), `${gate}/${kind}`).toBe(false);
    }
  });
  it("video_and_evidence_approvals_are_voided_by_a_new_version", async () => {
    for (const gate of ["video", "evidence"] as const) {
      const v = await seedVideo(db.pool);
      expect(await approve(v, await live(v, gate), gate)).toMatchObject({ ok: true });
      expect(await isApproved(db.pool, v, gate)).toBe(true);
      await bumpContent(db.pool, v, gate);
      expect(await isApproved(db.pool, v, gate), gate).toBe(false);
    }
  });
  it("app_role_cannot_update_or_delete_video_content", async () => {
    const v = await seedVideo(db.pool);
    await expect(db.pool.query("update video_content set body = '{}'::jsonb where video_id = $1", [v])).rejects.toMatchObject({ code: "42501" });
    await expect(db.pool.query("update video_content set file_path = 'x' where video_id = $1", [v])).rejects.toMatchObject({ code: "42501" });
    await expect(db.pool.query("delete from video_content where video_id = $1", [v])).rejects.toMatchObject({ code: "42501" });
  });
  it("overriding_system_value_cannot_pin_a_forged_approval_forever", async () => {
    const v = await seedVideo(db.pool);
    const h = await live(v);
    await approve(v, h);
    // A forged row with a sequence number and a time far in the future so it would always look newest.
    await db.pool.query(
      `insert into approvals (seq, decided_at, video_id, gate, content_hash, decision, note, decided_by, session_id, content_versions)
       overriding system value values (9223372036854775000, '2099-01-01', $1, 'script', $2, 'approved', null, 'session', $3, '{}'::jsonb)`,
      [v, h, SESSION_ID],
    );
    const rows = (await db.pool.query("select seq::text, decided_at < now() + interval '1 minute' as sane from approvals where video_id = $1 order by seq", [v])).rows;
    expect(rows.map((r) => r.sane)).toEqual([true, true]);
    expect(BigInt(rows[1].seq)).toBeLessThan(10n ** 6n);
    // A real send-back made afterwards must win: the forgery cannot stay "newest".
    await sendBack(db.pool, { videoId: v, gate: "script", seenHash: h, note: "send it back", actor: session });
    expect(await isApproved(db.pool, v, "script")).toBe(false);
    await expect(db.pool.query("select setval(pg_get_serial_sequence('approvals','seq'), 1)")).rejects.toMatchObject({ code: "42501" });
  });
  it("deleting_a_video_with_decisions_is_refused_so_the_ledger_cannot_be_erased", async () => {
    const v = await seedVideo(db.pool);
    await approve(v, await live(v));
    await expect(db.pool.query("delete from videos where id = $1", [v])).rejects.toMatchObject({ code: "23503" });
    expect((await db.pool.query("select count(*)::int n from approvals")).rows[0].n).toBe(1);
    const free = await seedVideo(db.pool);
    await db.pool.query("delete from videos where id = $1", [free]); // no decisions: still deletable
  });
  it("the_session_id_is_stored_with_the_decision_and_must_be_a_uuid", async () => {
    const v = await seedVideo(db.pool);
    await approve(v, await live(v));
    expect((await db.pool.query("select session_id from approvals where video_id = $1", [v])).rows[0].session_id).toBe(SESSION_ID);
    await expect(db.pool.query("insert into approvals (video_id, gate, content_hash, decision, decided_by, session_id, content_versions) values ($1,'script',$2,'approved','session',null,'{}'::jsonb)", [v, STALE])).rejects.toThrow(/null value|not-null/);
  });
  it("live_hash_comes_with_the_exact_content_versions_it_was_computed_from", async () => {
    const v = await seedVideo(db.pool);
    const a = (await liveGateHash(db.pool, v, "publish"))!;
    expect(Object.keys(a.versions).sort()).toEqual(["evidence", "metadata", "video"]);
    const vid = (await db.pool.query("select id, version from video_content where video_id = $1 and kind = 'video'", [v])).rows[0];
    expect(a.versions.video).toEqual({ id: vid.id, version: vid.version });
    const r = await approve(v, a.hash, "publish");
    expect(r).toMatchObject({ ok: true });
    const state = await approvalState(db.pool, v, "publish");
    expect(state).toEqual({ approved: true, hash: a.hash, versions: a.versions });
    await bumpContent(db.pool, v, "video");
    expect(await approvalState(db.pool, v, "publish")).toEqual({ approved: false });
    expect((await db.pool.query("select content_versions from approvals where video_id = $1", [v])).rows[0].content_versions).toEqual(a.versions);
  });
  it("a_note_with_nul_or_emoji_never_throws", async () => {
    const v = await seedVideo(db.pool);
    const h = await live(v);
    expect(await sendBack(db.pool, { videoId: v, gate: "script", seenHash: h, note: "bad\u0000note", actor: session })).toMatchObject({ ok: false });
    expect(await sendBack(db.pool, { videoId: v, gate: "script", seenHash: h, note: "x".repeat(10) + "\ud800", actor: session })).toMatchObject({ ok: false });
    expect(await sendBack(db.pool, { videoId: v, gate: "script", seenHash: h, note: "😀".repeat(600), actor: session })).toMatchObject({ ok: true });
  });
  it("cost_gate_refuses_an_all_null_plan", async () => {
    const v = await seedVideo(db.pool);
    await addContent(db.pool, v, "cost_plan", { body: { providers_models: null, path: null, library_scene_versions: null, quote: null }, sha256: sha256Hex("null-plan") });
    expect(await liveGateHash(db.pool, v, "cost")).toBeNull();
    expect(await approve(v, STALE, "cost")).toMatchObject({ ok: false });
  });
});
