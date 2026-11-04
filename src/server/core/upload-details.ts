// Upload details for one video (Phase 5 slice 3): title, description, tags, category, language, made-for-kids, synthetic
// content. Pure: no IO. Stored as part of the `metadata` content, so they are inside the publish approval's hash.
// Fails closed: made_for_kids and synthetic_content must be real booleans (an explicit choice, never a default here).

export const TITLE_MAX = 100;
export const DESCRIPTION_MAX_BYTES = 5000;
export const TAGS_MAX_CHARS = 500;
export const DEFAULT_CATEGORY = 27;

export interface UploadDetails {
  title: string;
  description: string;
  tags: string[];
  category_id: number;
  language: string;
  made_for_kids: boolean;
  synthetic_content: boolean;
}

const LANG_RE = /^([a-z]{2,3}(-[A-Za-z0-9]{2,8})?)?$/;
// NUL and other control characters (tab, line feed and carriage return are fine in a description only).
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const LINE_BREAK = /[\r\n\t]/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const chars = (s: string): number => [...s].length;

/** Checks raw input (form or stored body). Returns the cleaned value or every problem in plain words. */
export function validateUploadDetails(raw: unknown): { ok: true; value: UploadDetails } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  if (!isObj(raw)) return { ok: false, problems: ["the upload details are missing"] };
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  const description = typeof raw.description === "string" ? raw.description.trim() : "";
  if (title === "") problems.push("write a title");
  else {
    if (chars(title) > TITLE_MAX) problems.push(`the title is over ${TITLE_MAX} characters`);
    if (/[<>]/.test(title)) problems.push("the title cannot contain < or >");
    if (CONTROL.test(title) || LINE_BREAK.test(title)) problems.push("the title must be one plain line");
  }
  if (typeof raw.description !== "string") problems.push("the description is missing");
  else {
    if (Buffer.byteLength(description, "utf8") > DESCRIPTION_MAX_BYTES) problems.push(`the description is over ${DESCRIPTION_MAX_BYTES} bytes`);
    if (CONTROL.test(description)) problems.push("the description has characters that are not allowed");
  }
  const tags: string[] = [];
  if (!Array.isArray(raw.tags)) problems.push("tags must be a list");
  else {
    for (const t of raw.tags) {
      const s = typeof t === "string" ? t.trim() : "";
      if (s === "") continue;
      if (/[<>]/.test(s)) problems.push("tags cannot contain < or >");
      else if (CONTROL.test(s) || LINE_BREAK.test(s) || s.includes(",")) problems.push("a tag cannot contain a comma, line break or control character");
      else tags.push(s);
    }
    if (tags.join(",").length > TAGS_MAX_CHARS) problems.push(`the tags are over ${TAGS_MAX_CHARS} characters in total`);
  }
  const cat = raw.category_id;
  if (typeof cat !== "number" || !Number.isInteger(cat) || cat < 1 || cat > 99) problems.push("the category must be a number from 1 to 99");
  const lang = raw.language;
  if (typeof lang !== "string" || !LANG_RE.test(lang)) problems.push("the language must look like en or pt-BR");
  if (typeof raw.made_for_kids !== "boolean") problems.push("choose whether this video is made for kids");
  if (typeof raw.synthetic_content !== "boolean") problems.push("say whether the video has altered or synthetic content");
  if (problems.length) return { ok: false, problems: [...new Set(problems)] };
  return {
    ok: true,
    value: { title, description, tags, category_id: cat as number, language: lang as string, made_for_kids: raw.made_for_kids as boolean, synthetic_content: raw.synthetic_content as boolean },
  };
}

/** The first problem with the upload-detail fields of a stored metadata body, or null. Bodies without any of them (older rows) pass. */
export function storedDetailsProblem(body: unknown): string | null {
  if (!isObj(body)) return null;
  // "title" alone does not count: older bodies carry only a title and the visibility fields.
  const keys = ["description", "tags", "category_id", "language", "made_for_kids", "synthetic_content"];
  if (!keys.some((k) => k in body)) return null;
  const r = validateUploadDetails(body);
  return r.ok ? null : `the upload details are not valid: ${r.problems[0]}`;
}

export interface DetailsDefaults {
  channel: { categoryId: number; language: string; madeForKids: boolean; synthetic: boolean } | null;
  titles: { title: string; description: string; tags: string[] } | null;
  videoLanguage: string;
  scriptTitle: string;
}

/** What the form shows before anything is saved: the first drafted title, then the channel's defaults. Made for kids is "No" unless the channel says yes. */
export function defaultDetails(d: DetailsDefaults): UploadDetails {
  return {
    title: (d.titles?.title ?? d.scriptTitle).slice(0, TITLE_MAX),
    description: d.titles?.description ?? "",
    tags: d.titles?.tags ?? [],
    category_id: d.channel?.categoryId ?? DEFAULT_CATEGORY,
    language: d.channel?.language || d.videoLanguage,
    made_for_kids: d.channel?.madeForKids ?? false,
    synthetic_content: d.channel?.synthetic ?? false,
  };
}
