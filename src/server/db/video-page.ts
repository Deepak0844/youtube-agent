import type pg from "pg";
import { redactLine } from "@/server/core/log-redact";
import { STAGE_NAMES, stagePlan, type RunStatus, type StageName } from "@/server/core/pipeline-plan";
import { median, parseFindings, stageViews, type QaFinding, type RunFact, type StageGate, type StageView } from "@/server/core/video-page-view";
import type { GateId } from "@/server/core/gates";
import { approvalReaders } from "@/server/db/approval-readers";
import { approvalState } from "@/server/db/approvals";
import { getEngineConfig } from "@/server/db/engine-config";
import { readNextAction } from "@/server/db/pipeline";
import { mediaSigner } from "@/server/db/queue-data";
import { latestContent, type ContentKind, type VideoRow } from "@/server/db/videos";

// Everything /videos/[id] shows, read in one place. Read only. Media paths never leave this file: the page gets signed,
// expiring URLs (or null when the media key is locked or the file does not exist).

export interface VideoHead {
  id: string;
  topic: string;
  language: VideoRow["language"];
  kind: VideoRow["kind"];
  format: VideoRow["format"];
  status: VideoRow["status"];
  createdAt: string;
}
export interface LogRow { time: string; level: "info" | "warn" | "error"; text: string }
export interface AuditItem { id: string; at: string; event: string; detail: Record<string, unknown> }
export interface SpendRow { stage: string; spentMicroUsd: number; heldMicroUsd: number }
export interface VideoPage {
  head: VideoHead;
  stages: StageView[];
  /** The newest run status per stage, for the re-run buttons. */
  runStatus: Partial<Record<StageName, RunStatus>>;
  /** Median past duration per stage (ms), or null when fewer than 3 past runs exist. */
  estimates: Partial<Record<StageName, number | null>>;
  openGate: GateId | null;
  script: { body: unknown; approved: boolean; version: number } | null;
  beats: unknown;
  evidence: { body: unknown; fileSrc: string | null } | null;
  titles: unknown;
  metadata: unknown;
  costPlan: unknown;
  costPlanTotalMicroUsd: number | null;
  spend: { totalMicroUsd: number; heldMicroUsd: number; rows: SpendRow[] };
  qa: { findings: QaFinding[]; stills: string[] } | null;
  videoSrc: string | null;
  posterSrc: string | null;
  audit: AuditItem[];
  log: LogRow[];
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const asObj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const clip = (s: string, n = 240) => (s.length > n ? s.slice(0, n) + "..." : s);

/** Median past duration per stage over the newest 50 succeeded runs of any video. created_at to updated_at, so it includes queue wait. */
export async function stageEstimates(db: pg.Pool): Promise<Partial<Record<StageName, number | null>>> {
  const { rows } = await db.query<{ name: string; ms: number }>(
    `select name, ms from (
       select name, extract(epoch from (updated_at - created_at)) * 1000 as ms,
              row_number() over (partition by name order by created_at desc) as rn
         from stage_runs where status = 'succeeded' and name = any($1)
     ) t where rn <= 50`,
    [[...STAGE_NAMES]],
  );
  const by = new Map<string, number[]>();
  for (const r of rows) by.set(r.name, [...(by.get(r.name) ?? []), Number(r.ms)]);
  const out: Partial<Record<StageName, number | null>> = {};
  for (const n of STAGE_NAMES) out[n] = median(by.get(n) ?? []);
  return out;
}

const EVENT_TEXT: Record<string, string> = {
  "stage.started": "started", "stage.succeeded": "finished", "stage.failed": "failed", "stage.needs_decision": "needs your decision", "stage.cancelled": "cancelled",
  "gate.waiting": "waiting for you", "gate.approved": "approved", "gate.sent_back": "sent back", "video.created": "video created", "video.done": "video finished", "video.failed": "video failed",
};

export async function loadVideoPage(db: pg.Pool, videoId: string): Promise<VideoPage | null> {
  const vr = await db.query("select id, topic, language, kind, format, status, created_at from videos where id = $1", [videoId]);
  const v = vr.rows[0];
  if (!v) return null;
  const head: VideoHead = { id: v.id, topic: v.topic, language: v.language, kind: v.kind, format: v.format, status: v.status, createdAt: (v.created_at as Date).toISOString() };
  const live = head.status === "active" || head.status === "waiting";
  const sign = await mediaSigner(db, true);

  const runsR = await db.query<{ id: string; name: string; status: RunStatus; retry_of: string | null; created_at: Date; updated_at: Date; result: unknown }>(
    "select id, name, status, retry_of, created_at, updated_at, result from stage_runs where video_id = $1 order by created_at, id",
    [videoId],
  );
  const byId = new Map(runsR.rows.map((r) => [r.id, r]));
  const newest = new Map<string, (typeof runsR.rows)[number]>();
  for (const r of runsR.rows) newest.set(r.name, r);
  const facts: Partial<Record<StageName, RunFact>> = {};
  const runStatus: Partial<Record<StageName, RunStatus>> = {};
  for (const [name, r] of newest) {
    if (!(STAGE_NAMES as readonly string[]).includes(name)) continue;
    let retries = 0;
    for (let p = r.retry_of ? byId.get(r.retry_of) : undefined; p && retries < 100; p = p.retry_of ? byId.get(p.retry_of) : undefined) retries++;
    const res = asObj(r.result);
    const err = r.status === "failed" ? (typeof res.plain === "string" ? res.plain : typeof res.error === "string" ? res.error : null) : null;
    facts[name as StageName] = { status: r.status, createdAt: r.created_at.getTime(), updatedAt: r.updated_at.getTime(), retryNumber: retries, error: err ? clip(redactLine(err)) : null, percent: num(res.percent) };
    runStatus[name as StageName] = r.status;
  }

  const cost = await latestContent(db, videoId, "cost_plan");
  const costBody = asObj(cost?.body);
  const items = Array.isArray(costBody.items) ? costBody.items : [];
  const costTotal = cost ? Number(asObj(costBody.quote).micro_usd) : NaN;
  const paid = items.length > 0 || newest.has("generate");
  let plan;
  try {
    plan = stagePlan(head.kind, "short", { requireEvidence: false, paidGeneration: paid });
  } catch {
    plan = stagePlan("scene_kit", "short", { requireEvidence: false, paidGeneration: paid });
  }
  const gates: Partial<Record<StageName, StageGate>> = {};
  for (const s of plan) {
    if (s.gateBefore) gates[s.stage] = { gate: s.gateBefore, when: "before" };
    else if (s.gateAfter) gates[s.stage] = { gate: s.gateAfter, when: "after" };
  }
  let openGate: GateId | null = null;
  if (live) {
    const next = await readNextAction(db, videoId, approvalReaders).catch(() => null);
    if (next?.kind === "wait_gate") openGate = next.gate;
  }
  const estimates = await stageEstimates(db);
  const cfg = await getEngineConfig(db);
  const stages = stageViews({ plan: plan.map((s) => s.stage), gates, openGate, runs: facts, estimates, maxTries: cfg.retryAttempts, now: Date.now() });

  // Content. The script shown is the one the owner approved, else the newest draft.
  const body = async (kind: ContentKind) => latestContent(db, videoId, kind);
  const state = await approvalState(db, videoId, "script");
  let script: VideoPage["script"] = null;
  if (state.approved && state.versions.script) {
    const r = await db.query("select body, version from video_content where id = $1 and video_id = $2", [state.versions.script.id, videoId]);
    if (r.rows[0]) script = { body: r.rows[0].body, approved: true, version: r.rows[0].version };
  }
  if (!script) {
    const s = await body("script");
    if (s) script = { body: s.body, approved: false, version: s.version };
  }
  const [beats, evidence, titles, metadata, video] = await Promise.all([body("beats"), body("evidence"), body("titles"), body("metadata"), body("video")]);

  const spendR = await db.query<{ name: string; spent: string; held: string }>(
    `select sr.name, coalesce(sum(si.actual_micro_usd) filter (where si.status = 'done'), 0) as spent,
            coalesce(sum(si.reserved_micro_usd) filter (where si.status in ('pending','unknown')), 0) as held
       from stage_runs sr join spend_intents si on si.stage_run_id = sr.id where sr.video_id = $1 group by sr.name`,
    [videoId],
  );
  const rows = spendR.rows.map((r): SpendRow => ({ stage: r.name, spentMicroUsd: Number(r.spent), heldMicroUsd: Number(r.held) }));

  let qa: VideoPage["qa"] = null;
  const qaRun = [...runsR.rows].reverse().find((r) => r.name === "qa" && r.status === "succeeded");
  if (qaRun) {
    const res = asObj(qaRun.result);
    const files = Array.isArray(res.files) ? res.files.filter((f): f is string => typeof f === "string" && /^[\w.-]+\.png$/.test(f)) : [];
    const stills = files.map((f) => sign?.(`videos/${videoId}/${f}`) ?? null).filter((x): x is string => x !== null);
    qa = { findings: parseFindings(res.findings), stills };
  }

  const auditR = await db.query("select id::text as id, at, event, detail from audit_log where detail->>'videoId' = $1 order by id desc limit 50", [videoId]);
  const evR = await db.query("select at, type, payload from events where video_id = $1 order by id desc limit 100", [videoId]);
  const log: LogRow[] = [];
  for (const e of [...evR.rows].reverse()) {
    const time = (e.at as Date).toISOString().slice(11, 19);
    const p = asObj(e.payload);
    if (e.type === "log" && Array.isArray(p.lines)) for (const l of p.lines) log.push({ time, level: "info", text: `${typeof p.stage === "string" ? p.stage + ": " : ""}${String(l)}` });
    else if (EVENT_TEXT[e.type]) log.push({ time, level: e.type === "stage.failed" || e.type === "video.failed" ? "error" : e.type === "stage.needs_decision" || e.type === "gate.sent_back" ? "warn" : "info", text: `${typeof p.stage === "string" ? p.stage + " " : ""}${EVENT_TEXT[e.type]}` });
  }

  return {
    head, stages, runStatus, estimates, openGate, script,
    beats: beats?.body ?? null,
    evidence: evidence ? { body: evidence.body, fileSrc: sign?.(evidence.filePath) ?? null } : null,
    titles: titles?.body ?? null,
    metadata: metadata?.body ?? null,
    costPlan: cost?.body ?? null,
    costPlanTotalMicroUsd: Number.isFinite(costTotal) ? costTotal : null,
    spend: { totalMicroUsd: rows.reduce((a, r) => a + r.spentMicroUsd, 0), heldMicroUsd: rows.reduce((a, r) => a + r.heldMicroUsd, 0), rows },
    qa,
    videoSrc: video?.filePath ? (sign?.(video.filePath) ?? null) : null,
    posterSrc: qa?.stills[0] ?? null,
    audit: auditR.rows.map((r): AuditItem => ({ id: r.id, at: (r.at as Date).toISOString(), event: r.event, detail: asObj(r.detail) })),
    log,
  };
}
