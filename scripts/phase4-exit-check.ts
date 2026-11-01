import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, statfs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { priceCardFor } from "@/server/core/llm-catalog";
import { matchLocalService } from "@/server/core/local-services";
import { evaluate, exitCode, exitVerdict, formatChecklist, formatPlan, formatVerdict, isLanguage, LANGUAGES, timingExpectation, type Facts, type PlanModel, type StageModelFact } from "@/server/core/phase4-exit";
import { stagePlan } from "@/server/core/pipeline-plan";
import { secretName, type ProviderId } from "@/server/core/provider-keys";
import { BUDGET_DEFAULTS } from "@/server/core/settings-registry";
import { approvalState } from "@/server/db/approvals";
import { listBudgetTemplates } from "@/server/db/budget-scopes";
import { listModels, listRoutes, localServices } from "@/server/db/llm-models";
import { resolveRoute } from "@/server/db/media-registry";
import { getPool } from "@/server/db/pool";
import { getSetting } from "@/server/db/settings";
import { loadVideoPage } from "@/server/db/video-page";
import { latestContent } from "@/server/db/videos";
import { hasSecret } from "@/server/db/vault";
import { safeFetch } from "@/server/providers/net/safe-fetch";
import { assertVoiceStudioUrl } from "@/server/providers/voice/voicestudio";
import { storageRoot, videoPath } from "@/server/storage/paths";

// OWNER-RUN helper for the Phase 4 exit run. Read-only, spends nothing, starts no video and no service.
//   npm run check:phase4 -- --preflight            (default) readiness checklist, exit 1 if anything BLOCKs
//   npm run check:phase4 -- --plan [--lang hi]     what a real run would do, with the cost ceiling
//   npm run check:phase4 -- --check <videoId>      report on a finished or stuck run
// Only local commands run: docker info, docker image inspect, ffmpeg -version, ffprobe (execFile, args arrays, timeout).
const run = promisify(execFile);
const STAGES = ["draft", "build_scene_kit"] as const;
const NO_KEY = new Set(["ollama", "lmstudio", "claude_code"]);
const sh = (cmd: string, args: string[]): Promise<boolean> => run(cmd, args, { timeout: 10_000 }).then(() => true, () => false);
const get = async (fetchFn: () => Promise<Response>): Promise<boolean> => { try { return (await fetchFn()).ok; } catch { return false; } };
const out = (s: string) => process.stdout.write(s);

async function modelFacts(db: ReturnType<typeof getPool>): Promise<{ facts: StageModelFact[]; plan: PlanModel[] }> {
  const [models, routes, local] = await Promise.all([listModels(db), listRoutes(db), localServices(db)]);
  const facts: StageModelFact[] = [];
  const plan: PlanModel[] = [];
  for (const stage of STAGES) {
    const m = models.find((x) => x.id === routes[stage]);
    const card = m ? priceCardFor(m, local) : undefined;
    const keyPresent = m && !NO_KEY.has(m.provider) ? await hasSecret(db, secretName(m.provider as ProviderId)).catch(() => false) : null;
    facts.push({ stage, routed: Boolean(m), enabled: Boolean(m?.enabled), priced: Boolean(card), provider: m?.provider ?? null, label: m?.label ?? null, keyPresent });
    if (m && card) plan.push({ stage, label: m.label, provider: m.provider, inPerMTokMicro: card.inputPerMTokMicro, outPerMTokMicro: card.outputPerMTokMicro });
  }
  return { facts, plan };
}

async function preflight(): Promise<number> {
  const db = getPool();
  const dbOk = await db.query("select 1").then(() => true, () => false);
  let migrated = false;
  let facts: Partial<Facts> = {};
  if (dbOk) {
    const dir = path.resolve("src/server/db/migrations");
    const want = (await readdir(dir)).filter((f) => f.endsWith(".sql")).length;
    const have = await db.query<{ n: string }>("select count(*) as n from schema_migrations").then((r) => Number(r.rows[0]?.n), () => -1);
    migrated = have >= want;
    const voiceUrl = String((await getSetting(db, "voice.voicestudio_url")) ?? "");
    const list = await localServices(db);
    let listed = false;
    let reachable: boolean | null = null;
    if (voiceUrl) {
      try {
        assertVoiceStudioUrl(voiceUrl, false); // loopback only
        const u = new URL(voiceUrl);
        listed = matchLocalService(list, u);
        if (listed) reachable = await get(() => safeFetch(new URL("/health", u).toString(), { method: "GET" }, { mode: "typed", localServices: list, timeoutMs: 3000 }));
      } catch { listed = false; }
    }
    const t = await listBudgetTemplates(db).catch(() => null);
    const cap = (s: string) => (t ? t.templates.find((x) => x.scope === s)?.capMicroUsd : undefined);
    const dayCap = cap("day");
    const searx = process.env.SEARXNG_URL ?? null;
    let searxOk: boolean | null = null;
    // SearXNG is one of the app's OWN services (its port can never be on the local-services list): reach it the way Draft does (web-tools.ts).
    if (searx) {
      searxOk = await get(() => {
        const u = new URL(searx);
        const own = [{ host: u.hostname, port: Number(u.port || (u.protocol === "https:" ? 443 : 80)) }];
        return safeFetch(searx, { method: "GET" }, { mode: "typed", ownServices: own, localServices: [], timeoutMs: 3000 });
      });
    }
    const voiceRoute = await resolveRoute(db, "voice", { format: "short", videoKind: "scene_kit" }).catch(() => null);
    facts = {
      voiceUrl, voiceListed: listed, voiceReachable: reachable, models: (await modelFacts(db)).facts, voiceRoute,
      budgets: { dayCapMicro: dayCap, dayRemainingMicro: t && dayCap != null ? dayCap - t.today.spentMicroUsd - t.today.reservedMicroUsd : null, draftRunCapMicro: cap("draft_run") },
      searxUrl: searx, searxReachable: searxOk,
    };
  }
  await db.end().catch(() => undefined);
  const [daemon, image, ffmpeg, ffprobe, st] = await Promise.all([
    sh("docker", ["info"]), sh("docker", ["image", "inspect", "ytstudio-render:dev"]), sh("ffmpeg", ["-version"]), sh("ffprobe", ["-version"]),
    statfs(storageRoot()).catch(() => statfs(process.cwd())).catch(() => null),
  ]);
  const f: Facts = {
    db: { reachable: dbOk, migrated }, redisConfigured: Boolean(process.env.REDIS_URL),
    voiceUrl: "", voiceListed: false, voiceReachable: null, models: STAGES.map((stage) => ({ stage, routed: false, enabled: false, priced: false, provider: null, label: null, keyPresent: null })),
    docker: { daemon, image: daemon && image }, ffmpeg, ffprobe,
    freeDiskGb: st ? (Number(st.bavail) * Number(st.bsize)) / 1e9 : null, load1: os.loadavg()[0] ?? 0, cores: os.cpus().length,
    budgets: { dayCapMicro: undefined, dayRemainingMicro: null, draftRunCapMicro: undefined }, searxUrl: null, searxReachable: null, voiceRoute: null,
    ...facts,
  };
  const lines = evaluate(f);
  out(formatChecklist(lines));
  return exitCode(lines);
}

async function plan(lang: string): Promise<number> {
  if (!isLanguage(lang)) throw new Error(`--lang can be one of: ${LANGUAGES.join(", ")}.`);
  const db = getPool();
  try {
    const { plan: models } = await modelFacts(db);
    if (models.length < STAGES.length) out("Note: a model for draft or build_scene_kit is not routed and priced yet; run --preflight.\n\n");
    const videoCap = (await listBudgetTemplates(db)).templates.find((x) => x.scope === "video:scene_kit")?.capMicroUsd ?? BUDGET_DEFAULTS["video:scene_kit"]!;
    out(formatPlan({ lang, steps: stagePlan("scene_kit", "short", { requireEvidence: false, paidGeneration: false }), models, videoCapMicro: videoCap }));
  } finally { await db.end().catch(() => undefined); }
  return 0;
}

async function check(videoId: string): Promise<number> {
  const db = getPool();
  try {
    const page = await loadVideoPage(db, videoId);
    if (!page) { out("No such video on this machine.\n"); return 1; }
    const runs = await db.query<{ name: string; status: string; ms: number }>(
      "select distinct on (name) name, status, extract(epoch from (updated_at - created_at)) * 1000 as ms from stage_runs where video_id = $1 order by name, created_at desc", [videoId]);
    out(`Video ${videoId}: ${page.head.topic} (${page.head.language}), status ${page.head.status}\n\nStages:\n`);
    for (const r of runs.rows) out(`  ${r.name.padEnd(8)} ${r.status.padEnd(14)} ${(Number(r.ms) / 1000).toFixed(1)}s\n`);
    const cap = (await listBudgetTemplates(db)).templates.find((x) => x.scope === "video:scene_kit")?.capMicroUsd ?? null;
    out(`\nSpend: $${(page.spend.totalMicroUsd / 1_000_000).toFixed(4)} (held $${(page.spend.heldMicroUsd / 1_000_000).toFixed(4)})\n`);
    const root = storageRoot();
    let findings = page.qa?.findings ?? [];
    const qaFile = videoPath(root, videoId, "qa.json");
    if (existsSync(qaFile)) {
      try { const j = JSON.parse(await readFile(qaFile, "utf8")) as { findings?: typeof findings }; if (Array.isArray(j.findings)) findings = j.findings; } catch { /* keep the stage result */ }
    }
    out(`QA findings: ${findings.length === 0 ? "none" : ""}\n`);
    for (const f of findings) out(`  [${f.severity}] ${f.text}\n`);
    const caps = (await latestContent(db, videoId, "captions"))?.body as { timings_kind?: string } | null;
    const timing = caps?.timings_kind ?? null;
    out(`Narration timing: ${timing ?? "no captions yet"}${page.head.language === "ml" ? ` (expected ${timingExpectation("ml")})` : ""}\n`);
    const mp4 = videoPath(root, videoId, "render.mp4");
    const exists = existsSync(mp4);
    out(`render.mp4: ${exists ? mp4 : "not made yet"}\n`);
    if (exists) {
      const p = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration,size:stream=codec_name,width,height", "-of", "compact=p=0", mp4], { timeout: 15_000 }).catch(() => null);
      out(`  ffprobe: ${p ? p.stdout.trim().split("\n").join(" | ") : "ffprobe failed or missing"}\n`);
    }
    const gateOk = async (g: "script" | "video") => (await approvalState(db, videoId, g).catch(() => ({ approved: false }))).approved;
    out(`Video gate: ${page.openGate === "video" ? "waiting for you (reached)" : (await gateOk("video")) ? "approved" : "not reached"}\n\n`);
    const v = exitVerdict({
      stages: runs.rows.map((r) => ({ stage: r.name, status: r.status, durationMs: Number(r.ms) })), plannedStages: [],
      scriptApproved: await gateOk("script"), renderExists: exists, qaBlocks: findings.filter((f) => f.severity === "block").length, qaWarns: findings.filter((f) => f.severity === "warn").length,
      videoGateOpen: page.openGate === "video", videoApproved: await gateOk("video"), spendMicro: page.spend.totalMicroUsd, capMicro: cap, timingKind: timing,
    });
    out(formatVerdict(v));
    return v.pass ? 0 : 1;
  } finally { await db.end().catch(() => undefined); }
}

async function main(): Promise<number> {
  const a = process.argv.slice(2);
  const val = (n: string) => { const i = a.indexOf(`--${n}`); return i >= 0 ? a[i + 1] : undefined; };
  if (a.includes("--check")) {
    const id = val("check");
    if (!id) throw new Error("--check needs a video id (see the address of the video page).");
    return check(id);
  }
  if (a.includes("--plan")) return plan(val("lang") ?? "en");
  return preflight();
}

main().then((c) => { process.exitCode = c; }, (e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
