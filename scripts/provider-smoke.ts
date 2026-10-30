// Live provider smoke (Phase 3 Task 20). OWNER-RUN, spends real money on ElevenLabs (tiny calls). Never run by CI.
//
//   npm run smoke:providers -- --providers elevenlabs,pixabay --cap 0.50 --lang en,hi,ta [--yes-spend] [--dry-plan] [--voice <id>]
//
// --dry-plan prints the plan and quotes and calls nothing. Each call's quote is printed first and you answer y/N (a run with
// no terminal needs --yes-spend). Calls go through the same adapters and ctx.paid as production, booked against a dedicated
// `smoke:<run>` budget capped at --cap (hard max 2 USD), so your real budgets are untouched. Only a local development database
// is accepted. Raw provider responses (keys and credentials stripped) go to .data/smoke/fixtures/ (gitignored).
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { buildEngineConfig } from "@/server/core/engine-config";
import { NotProcessedError } from "@/server/core/error-class";
import { microToUsd } from "@/server/core/llm-catalog";
import { BudgetRefusedError, KnownFailure } from "@/server/core/paid-call";
import { secretName, type ProviderId } from "@/server/core/provider-keys";
import { createStageContext, type StageContext } from "@/server/core/stage-handler";
import { EDGE_VOICES } from "@/server/core/edge-voices";
import { formatSummary, moneyAnomalies, parseSmokeArgs, pickVoice, planSmoke, redactFixture, refuseEnvironment, SmokeRefusal, type Candidate, type Verdict } from "@/server/core/smoke-plan";
import { ensureCapScope, ensureScopeCopies, periodScopes } from "@/server/db/budget-scopes";
import { getPriceRule } from "@/server/db/media-registry";
import { loadKeyring } from "@/server/db/master-key";
import { createPgPaidCallPorts } from "@/server/db/paid-call-adapter";
import { openEvalStage } from "@/server/db/llm-eval";
import { getPool } from "@/server/db/pool";
import { commitStage, failStage } from "@/server/db/stages";
import { getSecret, hasSecret } from "@/server/db/vault";
import { safeFetch } from "@/server/providers/net/safe-fetch";
import { createElevenLabsSound } from "@/server/providers/sound/elevenlabs";
import { createStockProvider, defaultFetcher } from "@/server/providers/stock";
import { connectEdge, createEdgeVoice, type WebSocketLike } from "@/server/providers/voice/edge";
import type { SafeFetch } from "@/server/providers/voice/eleven-types";
import { createElevenLabsVoice } from "@/server/providers/voice/elevenlabs";

const ROOT = path.resolve(".data/smoke");
const FIXTURES = path.join(ROOT, "fixtures");
const NO_VOICE = "Create a voice in ElevenLabs (Voice Design) and set its id as the default narration voice on the Providers page. Or pass --voice <id>.";
const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));
const TAG = "[excited]";
// ASSUMPTION: sound effects and music bill in credits at an unknown rate; 1000 is a conservative stand-in for the allowance check.
const SOUND_CREDITS = 1000;
const SENTENCES: Record<string, string> = { en: "Hello, this is a short voice test.", hi: "नमस्ते, यह एक छोटा आवाज़ परीक्षण है।", ta: "வணக்கம், இது ஒரு சிறிய குரல் சோதனை." };

type State = "ok" | "plan" | "error" | "declined";
interface Outcome { state: State; msg: string; status?: number; code?: string; recorded?: number }
type Job = Candidate & { run(ctx: StageContext): Promise<string> };

async function main(): Promise<void> {
  const args = parseSmokeArgs(process.argv.slice(2));
  refuseEnvironment(process.env);
  const known = ["elevenlabs", "pixabay", "edge"];
  if (args.providers.some((p) => !known.includes(p))) throw new SmokeRefusal(`--providers can list: ${known.join(", ")}.`);
  if (args.langs.some((l) => !(l in SENTENCES))) throw new SmokeRefusal("--lang can list: en, hi, ta.");
  const capMicro = Math.round(args.capUsd * 1_000_000);
  const selected = new Set(args.providers);
  const db = getPool();
  let ring: ReturnType<typeof loadKeyring> | undefined;
  const runId = randomUUID();
  const outDir = path.join(ROOT, runId);
  const secrets: string[] = [];
  const have = new Set<string>();
  const keyOf = async (id: "elevenlabs" | "pixabay"): Promise<string> => {
    const k = await getSecret(db, (ring ??= loadKeyring()), secretName(id as ProviderId)); // decrypted per call, never kept
    if (!secrets.includes(k)) secrets.push(k); // only to strip it from fixtures
    return k;
  };
  try {
    for (const id of ["elevenlabs", "pixabay"] as const) if (selected.has(id) && (await hasSecret(db, secretName(id as ProviderId)))) have.add(id);

    // Records every response body (secrets stripped) while the adapter reads it; returns the text for the summary.
    const seen = new Map<string, { status: number; type: string; text: string }>();
    const statuses: number[] = [];
    let label = "call";
    let seq = 0;
    const record = async (res: Response): Promise<void> => {
      const type = res.headers.get("content-type") ?? "";
      const textual = /json|text/i.test(type);
      const body = textual ? await res.clone().text() : null;
      const bytes = textual ? 0 : (await res.clone().arrayBuffer()).byteLength;
      if (!res.ok) statuses.push(res.status);
      seen.set(label, { status: res.status, type, text: body ?? "" });
      await mkdir(FIXTURES, { recursive: true });
      const file = `${String(++seq).padStart(2, "0")}-${label}.${res.status}.${textual ? (/json/i.test(type) ? "json" : "txt") : "meta.json"}`;
      await writeFile(path.join(FIXTURES, file), redactFixture(body ?? JSON.stringify({ status: res.status, contentType: type, bytes }), secrets));
    };
    const elFetch: SafeFetch = async (url, init, o) => {
      const res = await safeFetch(url, init, { mode: "typed", localServices: [], ...o });
      await record(res);
      return res;
    };

    // ElevenLabs account, read-only. Unreadable = no paid ElevenLabs call (the allowance cannot be checked).
    type Acct = { count: number; limit: number; raw: Record<string, unknown> };
    // Read-only GET with the saved key; one 30 s wait on 429 (free-tier rate limit). null = unreadable, never a failure.
    const elGet = async (name: string, pathQuery: string): Promise<Response | null> => {
      for (let n = 0; n < 2; n++) {
        await sleep(2000); // free-tier rate limits: never two requests back to back
        label = name;
        try {
          const res = await elFetch(`https://api.elevenlabs.io${pathQuery}`, { method: "GET", headers: { "xi-api-key": await keyOf("elevenlabs") } }, { timeoutMs: 30_000, maxRedirects: 0 });
          if (!res.ok) await res.body?.cancel().catch(() => undefined);
          if (res.status !== 429 || n === 1) return res;
        } catch {
          return null;
        }
        await sleep(30_000);
      }
      return null;
    };
    const account = async (name: string): Promise<Acct | null> => {
      try {
        const res = await elGet(name, "/v1/user/subscription");
        const raw = res?.ok ? ((await res.json().catch(() => null)) as Record<string, unknown> | null) : null;
        return raw && Number.isFinite(raw.character_count) && Number.isFinite(raw.character_limit) ? { count: Number(raw.character_count), limit: Number(raw.character_limit), raw } : null;
      } catch {
        return null;
      }
    };
    let allowance: number | null = null;
    if (have.has("elevenlabs") && !args.dryPlan) {
      const a = await account("account-before");
      if (!a) {
        allowance = 0;
        process.stdout.write("ElevenLabs account: could not be read (key may lack the user_read permission), so no paid ElevenLabs call will be made.\n");
      } else {
        allowance = a.limit - a.count;
        const flags = Object.entries(a.raw).filter(([, v]) => typeof v === "boolean").map(([k, v]) => `${k}=${v}`).join(", ");
        process.stdout.write(`ElevenLabs account: plan ${String(a.raw.tier)} (${String(a.raw.status)}), ${allowance} of ${a.limit} credits left.\nFeature access: ${flags || "none reported"}\n`);
      }
    }

    // One tiny call per capability. Prices come from the media registry; an unpriced capability is skipped.
    const scope = `smoke:${runId}`;
    const budgetScopes = [scope]; // the owner's day and month copies are added before the first call
    const price = (id: string) => getPriceRule(db, id);
    const [vp, sp, mp] = await Promise.all([price("elevenlabs"), price("elevenlabs_sfx"), price("elevenlabs_music")]);
    // The narration voice must be one the account can use via the API: library voices are refused on the free plan (402).
    let voiceId = args.voice ?? "";
    let voiceWhy = "";
    if (selected.has("elevenlabs") && !voiceId && !args.dryPlan && have.has("elevenlabs")) {
      const res = await elGet("voices", "/v1/voices?page_size=100");
      if (res?.ok) voiceId = pickVoice(((await res.json().catch(() => ({}))) as { voices?: unknown }).voices) ?? "";
      voiceWhy = voiceId ? "" : res?.ok ? NO_VOICE : res && (res.status === 401 || res.status === 403) ? "The key cannot list voices (it needs the voices_read permission). Pass --voice <id>, or add that permission to the key." : "Your voices could not be listed. Pass --voice <id>.";
    } else if (!voiceId) voiceId = "dryplanvoice"; // dry plan only: quotes do not depend on the voice
    const base = { fetch: elFetch, getKey: () => keyOf("elevenlabs"), budgetScopes };
    const voice = createElevenLabsVoice({ ...base, model: "eleven_multilingual_v2", voiceId, price: vp });
    const tagged = createElevenLabsVoice({ ...base, model: "eleven_multilingual_v2", voiceId, price: vp, tags: { prefix: TAG } });
    const sound = createElevenLabsSound({ ...base, sfxPrice: sp, musicPrice: mp });
    const jobs: Job[] = [];
    const unpriced: Array<{ id: string; why: string }> = [];
    const words = (n: number, text: string) => `${n} word times for ${text.split(/\s+/).length} words`;
    if (selected.has("elevenlabs")) {
      if (voiceWhy) unpriced.push({ id: "voice", why: voiceWhy });
      else if (vp) {
        for (const model of ["eleven_multilingual_v2", "eleven_v3"]) for (const lang of args.langs) {
          const p = model === "eleven_v3" && lang === "en" ? tagged : voice;
          const a = { text: SENTENCES[lang]!, lang: lang as "en", voice: voiceId, model };
          jobs.push({ id: `voice-${model === "eleven_v3" ? "v3" : "v2"}-${lang}`, provider: "elevenlabs", label: `voice ${model} ${lang}`, quoteMicro: p.quote(a), needsKey: true, chars: Array.from(a.text).length,
            run: async (ctx) => { const r = await p.synthesise(ctx, a); return `${r.audioPath} | timings ${r.timingsKind}, ${r.wordTimings ? words(r.wordTimings.length, a.text) : "none"} | recorded ${r.priceMicroUsd} (${r.quoted ? "our quote" : "provider-reported"})`; } });
        }
      } else unpriced.push({ id: "voice", why: "ElevenLabs voice is not usable. Providers page, ElevenLabs VOICE row: turn on 'enabled' (and give it a price)." });
      const sfx = { prompt: "a short soft click", seconds: 2 };
      const music = { prompt: "calm soft piano", seconds: 3 };
      if (sp) jobs.push({ id: "sfx", provider: "elevenlabs", label: "sound effect, 2 s", quoteMicro: sound.quoteSfx(sfx), needsKey: true, chars: SOUND_CREDITS, run: async (ctx) => { const r = await sound.makeSfx(ctx, sfx); return `${r.path} | ${r.bytes} bytes | recorded ${r.provenance.priceMicroUsd}`; } });
      else unpriced.push({ id: "sfx", why: "ElevenLabs sound effects are not usable. Providers page, ElevenLabs SOUND EFFECTS row: turn on 'enabled' (and give it a price)." });
      if (mp) jobs.push({ id: "music", provider: "elevenlabs", label: "music, 3 s (shortest)", quoteMicro: sound.quoteMusic(music), needsKey: true, chars: SOUND_CREDITS, optional: true, run: async (ctx) => { const r = await sound.makeMusic(ctx, music); return `${r.path} | ${r.bytes} bytes | recorded ${r.provenance.priceMicroUsd}`; } });
      else unpriced.push({ id: "music", why: "ElevenLabs music is not usable. Providers page, ElevenLabs MUSIC row: turn on 'enabled' (and give it a price)." });
    }
    if (selected.has("pixabay")) {
      jobs.push({ id: "pixabay", provider: "pixabay", label: "Pixabay: one search and one small image", quoteMicro: 0, needsKey: true,
        run: async (ctx) => {
          const tee = async (url: string, init?: RequestInit) => { const r = await defaultFetcher(url, init); await record(r); return r; };
          const p = createStockProvider("pixabay", { getKey: () => keyOf("pixabay"), fetcher: tee });
          label = "pixabay-search";
          const hits = await p.search({ query: "cat", kind: "image", orientation: "landscape", count: 1 });
          if (!hits[0]) throw new Error("Pixabay found no image.");
          label = "pixabay-image";
          const a = await p.fetch({ attemptDir: ctx.attemptDir, signal: ctx.signal }, hits[0]);
          return `${a.path} | ${a.bytes} bytes | licence "${a.provenance.licence}"`;
        } });
    }
    const edgeSeen = new Set<string>();
    if (selected.has("edge")) {
      const lang = args.langs[0]!;
      const connect = (url: string, headers?: Record<string, string>): WebSocketLike => new Proxy(connectEdge(url, headers), {
        get: (t, k) => { const v = Reflect.get(t, k); return typeof v === "function" ? v.bind(t) : v; },
        set: (t, k, v) => {
          const h = v as ((ev: { data: unknown }) => void) | null;
          Reflect.set(t, k, k === "onmessage" && h ? (ev: { data: unknown }) => { if (typeof ev.data === "string") for (const m of ev.data.matchAll(/"Type"\s*:\s*"(\w+Boundary)"/g)) edgeSeen.add(m[1]!); h(ev); } : v);
          return true;
        },
      });
      const edge = createEdgeVoice({ connect });
      const a = { text: SENTENCES[lang]!, lang: lang as "en", voice: EDGE_VOICES[lang as "en"] };
      jobs.push({ id: "edge", provider: "edge", label: `Edge voice (free, no key) ${lang}`, quoteMicro: 0, needsKey: false, run: async (ctx) => { const r = await edge.synthesise(ctx, a); return `${r.audioPath} | timings ${r.timingsKind}, ${r.wordTimings ? words(r.wordTimings.length, a.text) : "none"}`; } });
    }

    const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    const plan = planSmoke({ candidates: jobs, selected, haveKey: (p) => have.has(p), capMicro, interactive, dryPlan: args.dryPlan, yesSpend: args.yesSpend, allowanceChars: allowance });
    const out = process.stdout;
    for (const s of [...unpriced, ...plan.skipped]) out.write(`SKIPPED ${s.id}: ${s.why}\n`);
    for (const c of plan.calls) out.write(`QUOTE ${c.label}: $${microToUsd(c.quoteMicro)}\n`);
    out.write(`Total quoted: $${microToUsd(plan.totalMicro)} of the $${args.capUsd.toFixed(2)} cap.\n`);
    if (args.dryPlan) { out.write("Dry plan: nothing was called.\n"); return; }

    await ensureCapScope(db, scope, capMicro);
    budgetScopes.push(...(await ensureScopeCopies(db, await periodScopes(db)))); // real day/month caps still apply
    await mkdir(outDir, { recursive: true });
    await mkdir(FIXTURES, { recursive: true });
    await writeFile(path.join(FIXTURES, "README.txt"), "Raw provider responses from `npm run smoke:providers` (keys and credentials stripped, check for anything personal before using).\nTo promote: copy a file into tests/fixtures/<area>/ replacing the matching `unrecorded` hand-written fixture (and drop its `unrecorded` marker) in a follow-up PR.\n");
    const stop = new AbortController();
    process.once("SIGINT", () => stop.abort());
    const ports = createPgPaidCallPorts(db);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const results = new Map<string, Outcome>();
    const rows: Array<{ id: string; quoteMicro: number; recordedMicro: number; failed?: boolean }> = [];
    const delta = new Map<string, number | null>();
    const usage = new Map<string, string>();
    let halted = false;
    try {
      for (const [i, job] of plan.calls.entries()) {
        if (halted || stop.signal.aborted) break;
        if (i > 0) await sleep(2000); // free-tier rate limits: strictly one call at a time, with a pause
        out.write(`\n${job.label}: quote $${microToUsd(job.quoteMicro)}\n`);
        if (!args.yesSpend && job.quoteMicro > 0 && !/^y(es)?$/i.test((await rl.question("Make this call? y/N ")).trim())) { results.set(job.id, { state: "declined", msg: "declined" }); continue; }
        const claim = await openEvalStage(db, `smoke-${runId}`, i);
        const ctx = createStageContext({ stage: { id: claim.stageRunId, name: "llm_eval", inputHash: "smoke", videoId: "00000000-0000-0000-0000-000000000000" }, claim, config: buildEngineConfig(new Map()), signal: stop.signal, paid: ports }).ctx;
        ctx.attemptDir = outDir;
        const before = job.provider === "elevenlabs" ? await account(`account-before-${job.id}`) : null;
        label = job.id;
        await sleep(2000);
        let o: Outcome;
        try {
          let msg: string;
          try {
            // The 429 is a NotProcessedError (a KnownFailure): the first attempt's reservation was released, and ctx.paid takes a fresh step for this one.
            msg = await job.run(ctx);
          } catch (e) {
            if (!(e instanceof NotProcessedError && e.status === 429)) throw e;
            out.write("Rate limited: waiting 30 s, then one more try.\n");
            await sleep(30_000);
            msg = await job.run(ctx);
          }
          o = { state: "ok", msg };
          await commitStage(db, claim, { smoke: true });
        } catch (err) {
          const status = err instanceof NotProcessedError ? err.status : undefined;
          const code = err instanceof NotProcessedError ? err.code : undefined;
          o = err instanceof BudgetRefusedError
            ? { state: "error", msg: "skipped: a day or month budget cap would be exceeded. Nothing was sent." }
            : (status === 402 || status === 403) && !job.id.startsWith("voice")
            ? { state: "plan", msg: "not available on this plan", status, ...(code ? { code } : {}) }
            : { state: "error", msg: code === "rate_limited" ? "rate limited" : err instanceof Error ? redactFixture(err.message, secrets).slice(0, 200) : "unknown error", ...(status ? { status } : {}), ...(code ? { code } : {}) };
          if (err instanceof KnownFailure || err instanceof BudgetRefusedError || job.quoteMicro === 0) await failStage(db, claim, "smoke_call_refused").catch(() => undefined);
          else halted = true; // unclear outcome: it may have been charged, so nothing more is sent
        }
        const spent = await db.query<{ actual: string }>("select coalesce(sum(actual_micro_usd), 0)::bigint as actual from spend_intents where stage_run_id = $1 and status = 'done'", [claim.stageRunId]);
        o.recorded = Number(spent.rows[0]!.actual);
        if (o.recorded > 0 || o.state === "ok") rows.push({ id: job.id, quoteMicro: job.quoteMicro, recordedMicro: o.recorded, failed: o.state !== "ok" });
        if (before) { const after = await account(`account-after-${job.id}`); delta.set(job.id, after ? after.count - before.count : null); usage.set(job.id, after ? `before ${before.count}, after ${after.count}` : `before ${before.count}, after unreadable`); }
        results.set(job.id, o);
        out.write(o.state === "ok" ? `OK ${o.msg}\nRecorded $${microToUsd(o.recorded)} vs quoted $${microToUsd(job.quoteMicro)}${delta.has(job.id) ? `; ElevenLabs credits used: ${String(delta.get(job.id))}` : ""}\n` : `${o.state === "plan" ? "NOT AVAILABLE ON THIS PLAN" : o.state.toUpperCase()}: ${o.msg}${o.status ? ` (${o.status}${o.code ? ` ${o.code}` : ""})` : ""}\n`);
        if (halted) out.write("Stopped: a call ended with an unclear outcome and may have been charged. Nothing more was sent.\n");
      }
    } finally {
      rl.close();
    }

    // Summary: what the earlier reviews could not verify.
    const st = (id: string) => results.get(id);
    const v = (id: string): Verdict => (st(id) ? (st(id)!.state === "ok" ? "confirmed" : st(id)!.state === "plan" ? "refused by plan" : "differs") : "not run");
    const d = (id: string, ok: string) => (st(id) ? (st(id)!.state === "ok" ? ok : st(id)!.msg) : "no call made");
    const json = (name: string): Record<string, unknown> | null => { try { return JSON.parse(seen.get(name)?.text ?? "") as Record<string, unknown>; } catch { return null; } };
    const align = json("voice-v3-en")?.alignment as { characters?: string[] } | undefined;
    const tagIn = align?.characters ? align.characters.join("").startsWith(TAG) : null;
    const wordsOf = (id: string) => /(\d+) word times for (\d+) words/.exec(st(id)?.msg ?? "");
    const timing = (lang: string): { verdict: Verdict; detail: string } => {
      const a = wordsOf(`voice-v2-${lang}`), b = wordsOf(`voice-v3-${lang}`);
      return a || b ? { verdict: [a, b].every((m) => !m || m[1] === m[2]) ? "confirmed" : "differs", detail: `v2: ${a?.[0] ?? "n/a"}; v3: ${b?.[0] ?? "n/a"}` } : { verdict: "not run", detail: "no voice call made" };
    };
    const px = json("pixabay-search");
    const hit = (px?.hits as Array<Record<string, unknown>> | undefined)?.[0];
    const hosts = hit ? [...new Set(Object.values(hit).flatMap((x) => (typeof x === "string" && /^https:\/\//.test(x) ? [new URL(x).hostname] : [])))] : [];
    const music = seen.get("music");
    const summary = [
      { item: "Sound-effect model eleven_text_to_sound_v2", verdict: v("sfx"), detail: d("sfx", "accepted") },
      { item: "Music model music_v2", verdict: v("music"), detail: d("music", "accepted") },
      { item: "Sound-effect billing unit (credits used for a 2 s clip)", verdict: delta.get("sfx") ? "confirmed" : st("sfx") ? "differs" : "not run", detail: `${usage.get("sfx") ?? "usage unreadable"} (usage may lag: re-check the dashboard); we quote a whole minute` },
      { item: "Music billing unit (credits used for a 3 s clip)", verdict: delta.get("music") ? "confirmed" : st("music") ? "differs" : "not run", detail: `${usage.get("music") ?? "usage unreadable"} (usage may lag: re-check the dashboard); we quote a whole minute` },
      { item: "Music answers with audio at once (no job id)", verdict: music ? (/audio/i.test(music.type) ? "confirmed" : "differs") : v("music"), detail: music ? `content-type ${music.type || "none"}` : "no response" },
      { item: "402/403 on the free plan", verdict: statuses.some((s) => s === 402 || s === 403) ? "refused by plan" : "not run", detail: `error statuses seen: ${statuses.join(", ") || "none"}` },
      { item: "v3 available on this plan", verdict: v("voice-v3-en") === "not run" ? v("voice-v3-hi") : v("voice-v3-en"), detail: d("voice-v3-en", "v3 line made") },
      { item: `v3 tag "${TAG}" appears in the character timings`, verdict: tagIn === null ? "not run" : tagIn ? "confirmed" : "differs", detail: tagIn === null ? "no v3 English response" : tagIn ? "tag characters are timed (the adapter strips them)" : "tag is NOT in the timings (the adapter strip is not needed)" },
      { item: "Hindi word timings v2 vs v3", ...timing("hi") },
      { item: "Tamil word timings v2 vs v3", ...timing("ta") },
      { item: "Pixabay answer shape and image hosts", verdict: hit ? (typeof hit.webformatURL === "string" && hosts.every((h) => ["pixabay.com", "cdn.pixabay.com"].includes(h)) ? "confirmed" : "differs") : v("pixabay"), detail: hit ? `fields: ${Object.keys(hit).join(", ")}; hosts: ${hosts.join(", ")}; licence in answer: ${"licence" in hit || "license" in hit}` : "no hit" },
      { item: "Edge sends word-level timings", verdict: selected.has("edge") ? (edgeSeen.has("WordBoundary") ? "confirmed" : "differs") : "not run", detail: `seen: ${[...edgeSeen].join(", ") || "none"}` },
    ] satisfies Array<{ item: string; verdict: Verdict; detail: string }>;
    out.write(`\n| Question | Result | Detail |\n|---|---|---|\n${formatSummary(summary)}\n\nFiles: ${outDir}\nFixtures: ${FIXTURES}\n`);
    const spent = rows.reduce((n, r) => n + r.recordedMicro, 0);
    out.write(`Spent (recorded): $${microToUsd(spent)} of the $${args.capUsd.toFixed(2)} cap.\n`);
    const bad = moneyAnomalies(capMicro, rows);
    if (bad.length > 0) { process.stderr.write(`MONEY ANOMALY: ${bad.join("; ")}\n`); process.exitCode = 1; }
    if (halted) process.exitCode = 1; // an unclear outcome may have been charged
  } finally {
    await db.end().catch(() => {});
  }
}
main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof SmokeRefusal ? err.message : `failed: ${err instanceof Error ? err.constructor.name : "unknown error"}`}\n`);
  process.exitCode = 1;
});
