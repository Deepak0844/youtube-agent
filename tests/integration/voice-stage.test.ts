import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildEngineConfig } from "@/server/core/engine-config";
import { sha256Hex, canonicalJson } from "@/server/core/content-hash";
import { uuidv7 } from "@/server/core/ids";
import { createPgPaidCallPorts } from "@/server/db/paid-call-adapter";
import { captionsNeedTick } from "@/server/core/approvals";
import { tickCaptions } from "@/server/db/queue-actions";
import { approvalState, approveGate, liveGateHash } from "@/server/db/approvals";
import { createStageContext, StageAbort } from "@/server/core/stage-handler";
import { runStage } from "@/server/db/stage-runner-adapter";
import { claimStage, insertQueuedStage } from "@/server/db/stages";
import { addContent, createVideoRow, latestContent } from "@/server/db/videos";
import { createFakeVoice, type FakeVoiceOptions } from "@/server/providers/voice/fake";
import { ok, throwsUnknown } from "@/server/providers/fake-base";
import { withAttempt } from "@/worker/stages/attempt";
import type { StageDeps } from "@/worker/stages/deps";
import { ttsAttempt } from "@/worker/stages/tts";
import { createVoiceFor, hostedFetch } from "@/worker/stages/voice-for";
import { withTestDb, type TestDb } from "../support/db";

let db: TestDb;
let root: string;
const config = buildEngineConfig(new Map());
const SESSION = { kind: "session", sessionId: "11111111-1111-4111-8111-111111111111" } as const;
const noProvider = { call: async () => Promise.reject(new Error("no provider")) };

beforeAll(async () => {
  db = await withTestDb();
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "voice-stage-")));
});
afterAll(async () => {
  rmSync(root, { recursive: true, force: true });
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
  await db.pool.query("insert into budgets (scope, cap_micro_usd) values ('draft_run', 3000000), ('video:scene_kit', 2000000), ('day', 15000000), ('month', 100000000)");
});

type Fake = ReturnType<typeof createFakeVoice>;
function deps(fake: Fake, over: Partial<StageDeps> = {}): StageDeps {
  return {
    db: db.pool, root,
    voiceFor: async (a) => ({ provider: fake.forScopes(a.budgetScopes), providerId: "fake", voice: "fake" }),
    image: {} as never, renderer: {} as never, ...over,
  } as StageDeps;
}

async function video(lang: "en" | "te" = "en", narration = "One fine line. Two fine lines. Three fine lines. Four fine lines.") {
  const v = await createVideoRow(db.pool, { format: "short", kind: "scene_kit", language: lang, topic: "t" });
  await setScript(v.id, narration);
  return v;
}
async function setScript(id: string, narration: string) {
  const body = { title: "T", narration };
  await addContent(db.pool, id, "script", { body, sha256: sha256Hex(canonicalJson(body)) });
  const b = { beats: [{ id: "b1", text: "x" }] };
  await addContent(db.pool, id, "beats", { body: b, sha256: sha256Hex(canonicalJson(b)) });
  const live = await liveGateHash(db.pool, id, "script");
  const r = await approveGate(db.pool, { videoId: id, gate: "script", seenHash: live!.hash, actor: SESSION });
  if (!r.ok) throw new Error(r.reason);
}
async function run(id: string, d: StageDeps, signal?: AbortSignal) {
  const inputHash = `h-${uuidv7()}`;
  const stageRunId = await insertQueuedStage(db.pool, { videoId: id, name: "tts", inputHash });
  void signal;
  return runStage(db.pool, { provider: noProvider, ttlMs: 60_000, workerId: "w1", handler: withAttempt({ db: db.pool, root }, ttsAttempt(d)), config }, { stageRunId, inputHash });
}
const spent = async (id: string) => Number((await db.pool.query("select spent_micro_usd s from budgets where scope = $1", [`video:${id}`])).rows[0]?.s ?? 0);
const intents = async () => Number((await db.pool.query("select count(*) n from spend_intents")).rows[0].n);
const captions = async (id: string) => (await latestContent(db.pool, id, "captions"))!.body as { approximate: boolean; needs_check: boolean; flags: string[]; timings_kind: string; words: Array<{ flags: string[] }> };
const opts = (o: FakeVoiceOptions = {}): FakeVoiceOptions => ({ pool: db.pool, ...o });

describe("voice stage", () => {
  it("reserve_covers_only_missing_lines", async () => {
    const fake = createFakeVoice(opts());
    const v = await video();
    expect((await run(v.id, deps(fake))).kind).toBe("committed");
    expect(fake.totalCalls()).toBe(4);
    expect(await spent(v.id)).toBe(4000);
    expect((await run(v.id, deps(fake))).kind).toBe("committed"); // all cached
    expect(fake.totalCalls()).toBe(4);
    expect(await spent(v.id)).toBe(4000);
    expect(await intents()).toBe(4);
  });

  it("second_run_after_one_line_rewrite_pays_one_line", async () => {
    const fake = createFakeVoice(opts());
    const v = await video();
    await run(v.id, deps(fake));
    await setScript(v.id, "One fine line. Two rewritten lines. Three fine lines. Four fine lines.");
    expect((await run(v.id, deps(fake))).kind).toBe("committed");
    expect(fake.totalCalls()).toBe(5);
    expect(await spent(v.id)).toBe(5000);
  });

  it("crash_after_line_3_resumes_without_repaying_lines_1_to_3", async () => {
    const fake = createFakeVoice(opts({ script: [ok(1000), ok(1000), ok(1000), throwsUnknown("socket hang up")] }));
    const v = await video();
    await expect(run(v.id, deps(fake))).rejects.toThrow("socket hang up"); // unknown outcome: intent stays pending, the reconciler parks it
    expect(fake.totalCalls()).toBe(4);
    expect(Number((await db.pool.query("select count(*) n from voice_lines")).rows[0].n)).toBe(3);
    const again = createFakeVoice(opts());
    expect((await run(v.id, deps(again))).kind).toBe("committed");
    expect(again.totalCalls()).toBe(1); // only line 4
  });

  it("cancel_mid_line_leaves_intent_pending_and_parks", async () => {
    const ctl = new AbortController();
    const fake = createFakeVoice(opts({ beforeCall: async () => { ctl.abort(new StageAbort("cancel")); await new Promise(() => undefined); } }));
    const v = await video();
    const stageId = await insertQueuedStage(db.pool, { videoId: v.id, name: "tts", inputHash: "h" });
    const claim = (await claimStage(db.pool, { id: stageId, inputHash: "h", workerId: "w1", ttlMs: 600_000 }))!;
    const ctx = createStageContext({ stage: { id: stageId, name: "tts", inputHash: "h", videoId: v.id }, claim, config, signal: ctl.signal, paid: createPgPaidCallPorts(db.pool) }).ctx;
    await expect(withAttempt({ db: db.pool, root }, ttsAttempt(deps(fake)))(ctx)).rejects.toBeInstanceOf(StageAbort);
    const pending = await db.pool.query("select count(*) n from spend_intents where status = 'pending'");
    expect(Number(pending.rows[0].n)).toBe(1); // never settled, never retried: the owner decides
    expect(Number((await db.pool.query("select count(*) n from voice_lines")).rows[0].n)).toBe(0);
    expect(fake.totalCalls()).toBe(0);
  });

  it("provider_without_timings_runs_alignment_and_flags_te_kn_ml", async () => {
    const fake = createFakeVoice(opts({ timings: "aligned" }));
    const v = await video("te", "అ ఆ ఇ. ఈ ఉ ఊ.");
    let aligned = 0;
    const d = deps(fake, { align: async (a) => { aligned++; return { timings_kind: "aligned", needs_check: false, flags: [], approximate: false, words: a.script.map((word, i) => ({ word, startS: i * 0.1, endS: i * 0.1 + 0.1, source: "recognised" as const, flags: [] })) }; } });
    expect((await run(v.id, d)).kind).toBe("committed");
    expect(aligned).toBeGreaterThan(0);
    const c = await captions(v.id);
    expect(c.timings_kind).toBe("aligned");
    expect(c.flags).toContain("language_unreliable");
    expect(c.approximate).toBe(true);
  });

  it("estimated_timings_set_approximate", async () => {
    const fake = createFakeVoice(opts({ timings: "aligned" })); // no word times, no aligner: estimated
    const v = await video();
    expect((await run(v.id, deps(fake))).kind).toBe("committed");
    const c = await captions(v.id);
    expect(c.timings_kind).toBe("estimated");
    expect(c.approximate).toBe(true);
    expect(c.needs_check).toBe(true);
  });

  it("line_over_tempo_cap_flags_needs_rewrite", async () => {
    const fake = createFakeVoice(opts({ wps: 0.5 })); // far slower than the window
    const v = await video();
    expect((await run(v.id, deps(fake))).kind).toBe("committed");
    const c = await captions(v.id);
    expect(c.flags).toContain("needs_rewrite");
    expect(c.needs_check).toBe(true);
  });

  it("unrouted_language_fails_before_reserve", async () => {
    const v = await video();
    const voiceFor = createVoiceFor(db.pool, () => { throw new Error("no ring"); });
    const o = await run(v.id, deps(createFakeVoice(opts()), { voiceFor }));
    expect(o.kind).toBe("known_failure");
    expect(await intents()).toBe(0);
  });

  it("disabled_or_unpriced_provider_is_refused_before_reserve", async () => {
    await db.ownerPool.query("insert into media_routes (kind, scope, provider, voice) values ('voice', 'default', 'elevenlabs', 'abc') on conflict (kind, scope) do update set provider = 'elevenlabs', voice = 'abc'");
    const v = await video();
    const voiceFor = createVoiceFor(db.pool, () => { throw new Error("no ring"); });
    expect((await run(v.id, deps(createFakeVoice(opts()), { voiceFor }))).kind).toBe("known_failure"); // elevenlabs is off
    expect(await intents()).toBe(0);
  });

  it("a_cached_row_whose_file_is_gone_is_a_miss", async () => {
    const fake = createFakeVoice(opts());
    const v = await video();
    await run(v.id, deps(fake));
    const rows = await db.pool.query<{ file_path: string }>("select file_path from voice_lines");
    for (const r of rows.rows) rmSync(path.join(root, r.file_path), { force: true });
    expect((await run(v.id, deps(fake))).kind).toBe("committed");
    expect(fake.totalCalls()).toBe(8);
  });

  it("another_provider_does_not_reuse_a_cached_line", async () => {
    const fake = createFakeVoice(opts());
    const v = await video();
    await run(v.id, deps(fake));
    const other = deps(fake, { voiceFor: async (a) => ({ provider: fake.forScopes(a.budgetScopes), providerId: "other", voice: "fake" }) });
    await run(v.id, other);
    expect(fake.totalCalls()).toBe(8);
  });

  it("hosted_fetch_forwards_no_redirects_and_timeout", async () => {
    const src = hostedFetch.toString();
    expect(src).toContain("...opts");
  });
});

describe("video gate and approximate captions", () => {
  const approveVideo = async (id: string, checked: boolean) => {
    const t = await tickCaptions(db.pool, id, SESSION, checked);
    if (!t.ok) return { ok: false, message: t.message };
    const live = await liveGateHash(db.pool, id, "video");
    const r = await approveGate(db.pool, { videoId: id, gate: "video", seenHash: t.hash ?? live!.hash, actor: SESSION });
    return { ok: r.ok, message: r.ok ? "" : r.reason };
  };
  async function ready() {
    const v = await video();
    await run(v.id, deps(createFakeVoice(opts({ timings: "aligned" })))); // estimated captions
    await addContent(db.pool, v.id, "video", { filePath: "x.mp4", sha256: "a".repeat(64) });
    await db.pool.query("update videos set status = 'active' where id = $1", [v.id]);
    return v;
  }

  it("estimated_timings_block_video_gate_until_ticked", async () => {
    const v = await ready();
    expect((await approveGate(db.pool, { videoId: v.id, gate: "video", seenHash: "0".repeat(64), actor: SESSION })).ok).toBe(false); // core refuses too
    const no = await approveVideo(v.id, false);
    expect(no.ok).toBe(false);
    expect(no.message).toMatch(/captions/);
    expect((await approveVideo(v.id, true)).ok).toBe(true);
    expect(Number((await db.pool.query("select count(*) n from audit_log where event = 'captions.checked'")).rows[0].n)).toBe(1);
    expect((await approvalState(db.pool, v.id, "video")).approved).toBe(true);
  });

  it("ticking_then_rewriting_a_line_voids_the_tick", async () => {
    const v = await ready();
    await approveVideo(v.id, true);
    expect((await db.pool.query("select 1 from approvals where video_id = $1 and gate = 'video'", [v.id])).rowCount).toBe(1);
    await setScript(v.id, "One fine line. Two rewritten lines. Three fine lines. Four fine lines.");
    await run(v.id, deps(createFakeVoice(opts({ timings: "aligned" })))); // new captions version, no tick
    const live = await liveGateHash(db.pool, v.id, "video");
    const state = await approvalState(db.pool, v.id, "video");
    expect(state.approved).toBe(false);
    expect(captionsNeedTick((await latestContent(db.pool, v.id, "captions"))!.body)).toBe(true);
    expect(live).not.toBeNull();
  });
});
