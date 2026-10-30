import type pg from "pg";
import { STAGE_NAMES, type RunStatus, type StageName } from "@/server/core/pipeline-plan";
import { BREAKER_STAGES, versionsKey, type BreakerStage, type QueueGate, QUEUE_GATES } from "@/server/core/queue-input";
import { scriptSchema } from "@/server/core/script-contract";
import { wordCount, isLang } from "@/server/core/lang";
import { getDecision, type DecisionDetail } from "@/server/db/decision";
import { readSnapshot } from "@/server/db/approvals";
import { breakerHold } from "@/server/db/breakers";
import { approvalReaders } from "@/server/db/approval-readers";
import { getCachedMediaKey, getOrCreateMediaKey } from "@/server/db/media-key";
import { readNextAction } from "@/server/db/pipeline";
import { latestContent } from "@/server/db/videos";
import { signMediaUrl } from "@/server/storage/sign";

// Everything /queue shows, read in one place. Read only: nothing here writes (a signed media key is created on first use,
// exactly as the media route's other callers do). The page renders what these return and posts the hash and versions back.

export interface GateClaim {
  text: string;
  kind: "sourced" | "computed";
  detail: string;
}
export type GateContent =
  | { kind: "script"; title: string; description: string | null; narration: string; words: number; beats: number; claims: GateClaim[]; readable: boolean }
  | { kind: "cost"; totalMicroUsd: number; path: string; models: Array<[string, string]>; items: Array<{ kind: string; provider: string; quoteMicroUsd: number }> }
  | { kind: "video"; src: string | null; shaPrefix: string; captions: "exact" | "approximate" | "check" | "checked"; rewriteLines: number[] }
  | { kind: "evidence"; claims: GateClaim[]; fileSrc: string | null; shaPrefix: string }
  | { kind: "publish"; title: string; description: string | null; visibility: string; publishAt: string | null; channel: string; videoSrc: string | null; evidenceShaPrefix: string };

/** What the Cut strip is drawn from; src/ui/domain/queue-strip.ts accepts exactly this shape (the server does not import UI code). */
export interface StripInput {
  runs: Partial<Record<StageName, RunStatus>>;
  openGate: QueueGate | null;
  upload: "publish_approved" | "uploading" | "uploaded" | "upload_failed" | null;
}

export interface QueueVideo {
  videoId: string;
  topic: string;
  language: string;
  channelId: string | null;
  waitingSince: string;
  strip: StripInput;
}
export interface GateItem extends QueueVideo {
  kind: "gate";
  gate: QueueGate;
  /** What the page was rendered with; posted back and compared with the live state on every action. */
  hash: string;
  versions: string;
  content: GateContent;
  /** The newest decision on this very content, when it was sent back. */
  sentBackNote: string | null;
}
export interface DecisionItem extends QueueVideo {
  kind: "decision";
  decision: DecisionDetail;
}
export interface BreakerItem {
  stage: BreakerStage;
  until: string | null;
}
export interface StrandedUpload {
  uploadId: string;
  videoId: string;
  topic: string;
  approvedAt: string;
}
export interface QueueData {
  items: Array<GateItem | DecisionItem>;
  breakers: BreakerItem[];
  stranded: StrandedUpload[];
}

const MAX_ITEMS = 50;
const asObj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export async function mediaSigner(db: pg.Pool): Promise<((rel: string | null | undefined) => string | null) | null> {
  let key: Buffer | null = null;
  try {
    key = (await getCachedMediaKey(db)) ?? (await getOrCreateMediaKey(db));
  } catch {
    key = null; // vault locked: the page still works, without a player
  }
  if (!key) return null;
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return (rel) => {
    if (!rel) return null;
    try {
      return signMediaUrl(rel, exp, key!);
    } catch {
      return null;
    }
  };
}

function claimsOf(script: unknown): { claims: GateClaim[]; parsed: ReturnType<typeof scriptSchema.safeParse> } {
  const parsed = scriptSchema.safeParse(script);
  const claims: GateClaim[] = parsed.success
    ? parsed.data.evidence.map((c) => ({ text: c.text, kind: c.kind, detail: c.kind === "sourced" ? `${c.source_url} - "${c.quote}"` : c.method }))
    : [];
  return { claims, parsed };
}

async function runsFor(db: pg.Pool, videoId: string): Promise<StripInput["runs"]> {
  const r = await db.query<{ name: string; status: RunStatus }>(
    "select distinct on (name) name, status from stage_runs where video_id = $1 order by name, created_at desc, id desc",
    [videoId],
  );
  const out: StripInput["runs"] = {};
  for (const row of r.rows) if ((STAGE_NAMES as readonly string[]).includes(row.name)) out[row.name as StageName] = row.status;
  return out;
}
async function uploadFor(db: pg.Pool, videoId: string): Promise<StripInput["upload"]> {
  const r = await db.query<{ status: "publish_approved" | "uploading" | "uploaded" | "upload_failed" }>("select status from uploads where video_id = $1 order by created_at desc limit 1", [videoId]);
  return r.rows[0]?.status ?? null;
}

async function contentFor(db: pg.Pool, gate: QueueGate, snap: Exclude<Awaited<ReturnType<typeof readSnapshot>>, "no_video">, lang: string, videoId: string, sign: Awaited<ReturnType<typeof mediaSigner>>): Promise<GateContent> {
  const c = snap.inputs.content;
  const src = (rel: string | null | undefined) => (sign ? sign(rel) : null);
  if (gate === "script") {
    const { parsed } = claimsOf(c.script?.body);
    if (!parsed.success) return { kind: "script", title: "Script", description: null, narration: JSON.stringify(c.script?.body ?? null), words: 0, beats: 0, claims: [], readable: false };
    const s = parsed.data;
    return { kind: "script", title: s.title, description: s.description ?? null, narration: s.narration, words: isLang(lang) ? wordCount(s.narration) : s.narration.split(/\s+/).filter(Boolean).length, beats: s.beats.length, claims: claimsOf(s).claims, readable: true };
  }
  if (gate === "cost") {
    const b = asObj(c.cost_plan?.body);
    const quote = asObj(b.quote);
    const items = Array.isArray(b.items) ? b.items.map(asObj).map((i) => ({ kind: str(i.kind), provider: str(i.provider), quoteMicroUsd: Number(i.quoteMicroUsd) || 0 })) : [];
    return { kind: "cost", totalMicroUsd: Number(str(quote.micro_usd)) || 0, path: str(b.path), models: Object.entries(asObj(b.providers_models)).map(([k, v]) => [k, str(v)] as [string, string]), items };
  }
  if (gate === "video") {
    const cap = asObj(c.captions?.body);
    const captions = cap.approximate === true ? (cap.checked_by_owner === true ? "checked" : "approximate") : cap.needs_check === true ? "check" : "exact";
    return { kind: "video", src: src(c.video?.filePath), shaPrefix: (c.video?.sha256 ?? "").slice(0, 12), captions, rewriteLines: Array.isArray(cap.rewrite_lines) ? cap.rewrite_lines.filter((n): n is number => Number.isInteger(n)) : [] };
  }
  const script = await latestContent(db, videoId, "script");
  const claims = claimsOf(script?.body).claims;
  if (gate === "evidence") return { kind: "evidence", claims, fileSrc: src(c.evidence?.filePath), shaPrefix: (c.evidence?.sha256 ?? "").slice(0, 12) };
  const meta = asObj(c.metadata?.body);
  return {
    kind: "publish",
    title: str(meta.title) || "(no title)",
    description: typeof meta.description === "string" ? meta.description : null,
    visibility: str(meta.visibility),
    publishAt: typeof meta.publish_at === "string" ? meta.publish_at : null,
    channel: snap.inputs.channelId ?? "",
    videoSrc: src(c.video?.filePath),
    evidenceShaPrefix: (c.evidence?.sha256 ?? "").slice(0, 12),
  };
}

export async function loadQueue(db: pg.Pool): Promise<QueueData> {
  const sign = await mediaSigner(db);
  const vids = await db.query<{ id: string; topic: string; language: string; channel_id: string | null; updated_at: Date }>(
    "select id, topic, language, channel_id, updated_at from videos where status in ('waiting','active') and format = 'short' order by updated_at, id limit $1",
    [MAX_ITEMS * 2],
  );
  const parked = await db.query<{ id: string; video_id: string }>("select id, video_id from stage_runs where status = 'needs_decision' order by created_at, id limit $1", [MAX_ITEMS]);
  const parkedByVideo = new Map(parked.rows.map((p) => [p.video_id, p.id]));
  const items: Array<GateItem | DecisionItem> = [];
  for (const v of vids.rows) {
    if (items.length >= MAX_ITEMS) break;
    const base = { videoId: v.id, topic: v.topic, language: v.language, channelId: v.channel_id, waitingSince: v.updated_at.toISOString() };
    const parkedId = parkedByVideo.get(v.id);
    if (parkedId) {
      const decision = await getDecision(db, parkedId);
      if (decision) items.push({ ...base, kind: "decision", decision, strip: { runs: await runsFor(db, v.id), openGate: null, upload: await uploadFor(db, v.id) } });
      continue;
    }
    const action = await readNextAction(db, v.id, approvalReaders);
    if (action?.kind !== "wait_gate" || !(QUEUE_GATES as readonly string[]).includes(action.gate)) continue;
    const gate = action.gate as QueueGate;
    const snap = await readSnapshot(db, v.id, gate);
    if (snap === "no_video" || !snap.live.ok) continue;
    const content = await contentFor(db, gate, snap, v.language, v.id, sign);
    items.push({
      ...base,
      kind: "gate",
      gate,
      hash: snap.live.hash,
      versions: versionsKey(snap.versions),
      content,
      sentBackNote: snap.last?.decision === "sent_back" && snap.last.hash === snap.live.hash ? await noteOf(db, v.id, gate) : null,
      strip: { runs: await runsFor(db, v.id), openGate: gate, upload: await uploadFor(db, v.id) },
    });
  }
  const breakers: BreakerItem[] = [];
  for (const stage of BREAKER_STAGES) {
    const hold = await breakerHold(db, stage);
    if (hold) breakers.push({ stage, until: hold.until ? hold.until.toISOString() : null });
  }
  const stranded = await db.query<{ id: string; video_id: string; topic: string | null; created_at: Date }>(
    "select u.id, u.video_id, v.topic, u.created_at from uploads u join videos v on v.id = u.video_id where u.status = 'publish_approved' and v.status in ('active','waiting') order by u.created_at limit 20",
  );
  return { items, breakers, stranded: stranded.rows.map((r) => ({ uploadId: r.id, videoId: r.video_id, topic: r.topic ?? "(video)", approvedAt: r.created_at.toISOString() })) };
}

async function noteOf(db: pg.Pool, videoId: string, gate: string): Promise<string | null> {
  const r = await db.query<{ note: string | null }>("select note from approvals where video_id = $1 and gate = $2 and decision = 'sent_back' order by seq desc limit 1", [videoId, gate]);
  return r.rows[0]?.note ?? null;
}
