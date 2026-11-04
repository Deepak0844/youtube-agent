import type pg from "pg";
import { actorProblem, ACTOR_REASON, type GateActor } from "@/server/core/approvals";
import { canonicalJson, sha256Hex } from "@/server/core/content-hash";
import { defaultDetails, validateUploadDetails, type UploadDetails } from "@/server/core/upload-details";
import { recordAudit } from "./audit";
import { addContent, latestContent } from "./videos";

// Upload details live in the `metadata` content of the video (new version per save, append-only). The publish gate hashes
// the newest metadata version, so saving a change after an approval voids that approval. visibility and publish_at stay
// as they are (the publish approval slice sets them); a first save starts private with no schedule.

export interface DetailsView {
  saved: UploadDetails | null;
  /** what the form starts with when nothing is saved */
  draft: UploadDetails;
  channelTitle: string | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export async function loadUploadDetails(db: pg.Pool, videoId: string): Promise<DetailsView | null> {
  const v = await db.query<{ language: string; topic: string; channel_id: string | null }>("select language, topic, channel_id from videos where id = $1", [videoId]);
  const video = v.rows[0];
  if (!video) return null;
  const ch = video.channel_id === null ? undefined : (await db.query<{ title: string; category_id: number; default_language: string; made_for_kids: boolean; synthetic_disclosure_default: boolean }>(
    "select title, category_id, default_language, made_for_kids, synthetic_disclosure_default from youtube_channels where channel_id = $1", [video.channel_id])).rows[0];
  const meta = await latestContent(db, videoId, "metadata");
  const parsed = validateUploadDetails(meta?.body);
  const titles = (await latestContent(db, videoId, "titles"))?.body as { options?: Array<{ text?: unknown }>; description?: unknown; tags?: unknown } | null | undefined;
  const first = titles?.options?.[0]?.text;
  const draft = defaultDetails({
    channel: ch ? { categoryId: ch.category_id, language: ch.default_language, madeForKids: ch.made_for_kids, synthetic: ch.synthetic_disclosure_default } : null,
    titles: typeof first === "string" ? { title: first, description: typeof titles?.description === "string" ? titles.description : "", tags: Array.isArray(titles?.tags) ? titles.tags.filter((t): t is string => typeof t === "string") : [] } : null,
    videoLanguage: video.language,
    scriptTitle: video.topic,
  });
  return { saved: parsed.ok ? parsed.value : null, draft, channelTitle: ch?.title ?? null };
}

export type SaveDetailsResult = { ok: true } | { ok: false; message: string };

/** Owner session only. Validates on the server, then adds a new metadata version (so any publish approval is voided). */
export async function saveUploadDetails(db: pg.Pool, videoId: string, input: unknown, actor: GateActor): Promise<SaveDetailsResult> {
  if (actorProblem(actor)) return { ok: false, message: ACTOR_REASON };
  const r = validateUploadDetails(input);
  if (!r.ok) return { ok: false, message: r.problems.join("; ") };
  const v = await db.query<{ status: string }>("select status from videos where id = $1", [videoId]);
  if (!v.rows[0]) return { ok: false, message: "That video was not found." };
  if (!["active", "waiting"].includes(v.rows[0].status)) return { ok: false, message: "This video is no longer in production." };
  const prev = await latestContent(db, videoId, "metadata");
  const old = isObj(prev?.body) ? prev.body : {};
  const body = { ...r.value, visibility: typeof old.visibility === "string" ? old.visibility : "private", publish_at: old.publish_at ?? null };
  await addContent(db, videoId, "metadata", { body, sha256: sha256Hex(canonicalJson(body)), producedBy: null });
  await recordAudit(db, "upload_details.saved", { videoId, sessionId: actor.sessionId, madeForKids: r.value.made_for_kids, categoryId: r.value.category_id });
  return { ok: true };
}
