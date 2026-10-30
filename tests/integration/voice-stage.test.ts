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
import { approvalState, approveGate, CAPTIONS_REASON, liveGateHash } from "@/server/db/approvals";
import { createStageContext, StageAbort } from "@/server/core/stage-handler";
import { runStage } from "@/server/db/stage-runner-adapter";
import { claimStage, insertQueuedStage } from "@/server/db/stages";
import { addContent, createVideoRow, latestContent } from "@/server/db/videos";
import { createFakeVoice, type FakeVoiceOptions } from "@/server/providers/voice/fake";
import { ok, throwsUnknown } from "@/server/providers/fake-base";
import { prepareAttempt, withAttempt } from "@/worker/stages/attempt";
import { sweepLostAttempts } from "@/server/storage/store";
import { safeFetch } from "@/server/providers/net/safe-fetch";
import http from "node:http";
import type { StageDeps } from "@/worker/stages/deps";
import { ttsAttempt } from "@/worker/stages/tts";
import { createVoiceFor, makeHostedFetch } from "@/worker/stages/voice-for";
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

  it("no_route_fails_before_reserve", async () => {
    const v = await video();
    const voiceFor = createVoiceFor(db.pool, () => { throw new Error("no ring"); });
    const o = await run(v.id, deps(createFakeVoice(opts()), { voiceFor }));
    expect(o.kind).toBe("known_failure");
    expect(await intents()).toBe(0);
  });

  it("unsupported_language_fails_before_reserve", async () => {
    const fake = createFakeVoice(opts({ languages: ["hi"] }));
    const v = await video("en");
    expect((await run(v.id, deps(fake))).kind).toBe("known_failure");
    expect(await intents()).toBe(0);
    expect(fake.totalCalls()).toBe(0);
  });

  it("compressed_audio_without_ffmpeg_fails_before_reserve", async () => {
    const fake = createFakeVoice(opts({ formats: ["mp3"] }));
    const v = await video();
    expect((await run(v.id, deps(fake))).kind).toBe("known_failure");
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

  it("hosted_fetch_does_not_follow_a_redirect", async () => {
    let hits = 0;
    const srv = http.createServer((_q, r) => { hits++; r.writeHead(307, { location: "/again" }).end(); });
    await new Promise<void>((done) => srv.listen(0, "127.0.0.1", done));
    const port = (srv.address() as { port: number }).port;
    // the real safeFetch, allowed to reach this one local server; the per-call options come through makeHostedFetch
    const f = makeHostedFetch((u, i, o) => safeFetch(u, i, { ...o, mode: "typed", localServices: [`127.0.0.1:${port}`] }));
    try {
      await expect(f(`http://127.0.0.1:${port}/x`, { method: "POST", body: "{}" }, { timeoutMs: 5000, maxRedirects: 0 })).rejects.toThrow();
    } finally {
      srv.close();
    }
    expect(hits).toBe(1); // a followed 307 would have re-sent the paid POST
  });

  it("paid_audio_survives_a_new_fence_and_a_swept_attempt_folder", async () => {
    const v = await video("en", "Only one line here.");
    const fake = createFakeVoice(opts());
    const stageId = await insertQueuedStage(db.pool, { videoId: v.id, name: "tts", inputHash: "h" });
    const mk = async (worker: string) => {
      const claim = (await claimStage(db.pool, { id: stageId, inputHash: "h", workerId: worker, ttlMs: 600_000 }))!;
      const ctx = createStageContext({ stage: { id: stageId, name: "tts", inputHash: "h", videoId: v.id }, claim, config, signal: new AbortController().signal, paid: createPgPaidCallPorts(db.pool) }).ctx;
      await prepareAttempt(ctx, root);
      return ctx;
    };
    // Attempt 1: the provider is paid and settled, then the worker dies before the line is stored.
    const dies: StageDeps = deps(fake, { voiceFor: async (a) => ({ provider: { ...fake.forScopes(a.budgetScopes), synthesise: async (c, x) => { await fake.forScopes(a.budgetScopes).synthesise(c, x); throw new Error("worker died"); } }, providerId: "fake", voice: "fake" }) });
    await expect(ttsAttempt(dies)(await mk("w1"))).rejects.toThrow("worker died");
    expect(Number((await db.pool.query("select count(*) n from voice_lines")).rows[0].n)).toBe(0);
    // Another worker takes over (higher fence); the lost attempt's folder is swept.
    await db.ownerPool.query("update stage_runs set status='queued', lease_owner=null, lease_until=null where id=$1", [stageId]);
    const ctx2 = await mk("w2");
    expect(ctx2.claim.fence).toBe(2);
    expect(await sweepLostAttempts(db.pool, { root })).toBeGreaterThanOrEqual(1);
    const out = await ttsAttempt(deps(fake))(ctx2);
    expect(out.files).toEqual(["narration.wav"]);
    expect(fake.totalCalls()).toBe(1); // the replay used the stored result: no second provider call
    expect(Number((await db.pool.query("select count(*) n from voice_lines")).rows[0].n)).toBe(1);
    expect(await spent(v.id)).toBe(1000);
  });
});

describe("video gate and approximate captions", () => {
  const approveVideo = async (id: string, checked: boolean) => {
    const seen = await liveGateHash(db.pool, id, "video");
    const t = await tickCaptions(db.pool, id, SESSION, checked, { captionsId: seen!.versions.captions?.id, videoId: seen!.versions.video?.id });
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
    const blocked = await approveGate(db.pool, { videoId: v.id, gate: "video", seenHash: (await liveGateHash(db.pool, v.id, "video"))!.hash, actor: SESSION });
    expect(blocked).toEqual({ ok: false, reason: CAPTIONS_REASON }); // the CORE guard, with the correct live hash
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

  it("a_newer_captions_or_video_version_between_look_and_tick_is_refused", async () => {
    const v = await ready();
    const seen = await liveGateHash(db.pool, v.id, "video");
    const c = (await latestContent(db.pool, v.id, "captions"))!.body;
    await addContent(db.pool, v.id, "captions", { body: c, sha256: sha256Hex(canonicalJson(c)) }); // lands after the owner looked
    const t = await tickCaptions(db.pool, v.id, SESSION, true, { captionsId: seen!.versions.captions?.id, videoId: seen!.versions.video?.id });
    expect(t.ok).toBe(false);
    const seen2 = await liveGateHash(db.pool, v.id, "video");
    await addContent(db.pool, v.id, "video", { filePath: "y.mp4", sha256: "b".repeat(64) });
    const t2 = await tickCaptions(db.pool, v.id, SESSION, true, { captionsId: seen2!.versions.captions?.id, videoId: seen2!.versions.video?.id });
    expect(t2.ok).toBe(false);
    expect(Number((await db.pool.query("select count(*) n from audit_log where event = 'captions.checked'")).rows[0].n)).toBe(0);
  });

  it("two_ticks_at_once_add_one_version", async () => {
    const v = await ready();
    const seen = await liveGateHash(db.pool, v.id, "video");
    const s = { captionsId: seen!.versions.captions?.id, videoId: seen!.versions.video?.id };
    await Promise.all([tickCaptions(db.pool, v.id, SESSION, true, s), tickCaptions(db.pool, v.id, SESSION, true, s)]);
    expect(Number((await db.pool.query("select count(*) n from video_content where video_id = $1 and kind = 'captions'", [v.id])).rows[0].n)).toBe(2); // the estimate and ONE tick
  });

  it("a_video_version_landing_after_the_tick_commit_is_not_approved_unseen", async () => {
    const v = await ready();
    const seen = await liveGateHash(db.pool, v.id, "video");
    // A pool whose connections add a new video version right after the tick's transaction commits.
    const racing = new Proxy(db.pool, {
      get(t, k) {
        if (k !== "connect") return Reflect.get(t, k).bind ? (Reflect.get(t, k) as (...a: unknown[]) => unknown).bind(t) : Reflect.get(t, k);
        return async () => {
          const c = await t.connect();
          return new Proxy(c, {
            get(ct, ck) {
              if (ck !== "query") return typeof Reflect.get(ct, ck) === "function" ? (Reflect.get(ct, ck) as (...a: unknown[]) => unknown).bind(ct) : Reflect.get(ct, ck);
              return async (...a: unknown[]) => {
                const r = await (ct.query as (...x: unknown[]) => Promise<unknown>)(...a);
                if (a[0] === "commit") await addContent(db.pool, v.id, "video", { filePath: "late.mp4", sha256: "c".repeat(64) });
                return r;
              };
            },
          });
        };
      },
    });
    const t = await tickCaptions(racing as never, v.id, SESSION, true, { captionsId: seen!.versions.captions?.id, videoId: seen!.versions.video?.id });
    expect(t.ok).toBe(false);
  });
});
