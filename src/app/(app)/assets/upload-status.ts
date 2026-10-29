// Pure helpers for the upload zone. GET /api/uploads/<id> returns the file name HTML-escaped; React escapes again on
// render, so a status name is decoded once (one pass, so "&amp;lt;" becomes "&lt;", never "<") before it is shown.
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" };
export const decodeName = (s: string): string => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e: string) => ENTITIES[e]!);

const HEIC = /\.(heic|heif)$/i;
export const HEIC_MESSAGE = "HEIC photos are not supported. Convert the photo to JPEG or PNG and upload again.";
/** Refuses HEIC before any byte is sent (the server refuses it too, by its bytes). */
export const heicRefusal = (f: { name: string; type: string }): string | null => (HEIC.test(f.name) || /^image\/hei[cf]$/i.test(f.type) ? HEIC_MESSAGE : null);

export type UploadState = "ready" | "sending" | "checking" | "done" | "failed";
