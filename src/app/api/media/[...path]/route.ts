import { constants as fsc } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { assertAllowedHost } from "@/lib/auth/origin";
import { getCachedMediaKey } from "@/server/db/media-key";
import { getPool } from "@/server/db/pool";
import { safeJoin, storageRoot } from "@/server/storage/paths";
import { precheckMediaUrl, verifyMediaUrl } from "@/server/storage/sign";

// GET/HEAD /api/media/<path relative to the storage root>?e=<unix seconds>&s=<HMAC>
//
// Public on purpose and OUTSIDE proxy.ts (it streams large files): the signed URL is the only credential. No cookie is
// read, so a session neither helps nor hurts. Order of work, which tests/unit/route-inventory.test.ts pins:
//   1. Host allow-list.  2. Key-free precheck (shapes, path format, expiry), then verify the signature (nothing on disk is touched before this succeeds).
//   3. Only then resolve the file. Every failure before step 3 is the same 403, so a caller learns nothing about which
//   files exist. The query string (it carries the signature) and the key are never logged.
// Only the exported GET and HEAD may live here (the route checker enforces it); helpers sit below.

type Ctx = { params: Promise<{ path: string[] }> };

export async function GET(request: Request, ctx: Ctx): Promise<Response> {
  const bad = assertAllowedHost(request);
  if (bad) return bad;
  return serve(request, ctx, false);
}

export async function HEAD(request: Request, ctx: Ctx): Promise<Response> {
  const bad = assertAllowedHost(request);
  if (bad) return bad;
  return serve(request, ctx, true);
}

async function serve(request: Request, ctx: Ctx, head: boolean): Promise<Response> {
  let rel: string;
  try {
    rel = (await ctx.params).path.join("/");
  } catch {
    return forbidden();
  }
  const q = new URL(request.url).searchParams;
  const e = q.getAll("e");
  const s = q.getAll("s");
  if (e.length !== 1 || s.length !== 1 || [...q.keys()].some((k) => k !== "e" && k !== "s")) return forbidden();

  // Cheap, key-free checks first: junk and expired URLs never cost a database read or a vault decrypt.
  const input = { path: rel, e: e[0]!, s: s[0]! };
  if (!precheckMediaUrl(input, Math.floor(Date.now() / 1000)).ok) return forbidden();

  let key: Buffer | null;
  try {
    key = await getCachedMediaKey(getPool());
  } catch {
    return unavailable(); // wrong/missing vault key or DB down: say so, never fall back to unsigned serving
  }
  if (!key) return forbidden(); // no key yet means no URL was ever signed
  const v = verifyMediaUrl(input, key, Math.floor(Date.now() / 1000));
  if (!v.ok) return forbidden();
  const parts = v.path.split("/");
  const type = SERVED_ROOTS.has(parts[0]!) ? TYPES[path.extname(parts[parts.length - 1]!).toLowerCase()] : undefined;
  if (!type) return notFound();

  const file = await openRegularFile(parts);
  if (!file) return notFound();
  const { fh, size } = file;
  try {
    const range = request.headers.has("if-range") ? ({ kind: "none" } as const) : parseRange(request.headers.get("range"), size);
    if (range.kind === "bad") {
      await fh.close();
      return new Response(null, { status: 416, headers: { ...baseHeaders(type, parts), "content-range": `bytes */${size}` } });
    }
    const [start, end] = range.kind === "ok" ? [range.start, range.end] : [0, size - 1];
    const length = size === 0 ? 0 : end - start + 1;
    const headers: Record<string, string> = { ...baseHeaders(type, parts), "content-length": String(length) };
    if (range.kind === "ok") headers["content-range"] = `bytes ${start}-${end}/${size}`;
    const status = range.kind === "ok" ? 206 : 200;
    if (head || length === 0) {
      await fh.close();
      return new Response(null, { status, headers });
    }
    const stream = fh.createReadStream({ start, end, autoClose: true });
    request.signal.addEventListener("abort", () => stream.destroy(), { once: true });
    return new Response(Readable.toWeb(stream) as ReadableStream, { status, headers });
  } catch {
    await fh.close().catch(() => undefined);
    return notFound();
  }
}

// ---- helpers (below the handlers on purpose, see the note at the top) --------------------------------------------------

const SERVED_ROOTS = new Set(["videos", "assets"]);

// Allow-list by extension. No html, svg or anything else a browser would execute; unknown extensions are not served.
const MEDIA = "media";
const FILE = "file";
const TYPES: Record<string, { mime: string; kind: typeof MEDIA | typeof FILE } | undefined> = {
  ".mp4": { mime: "video/mp4", kind: MEDIA },
  ".webm": { mime: "video/webm", kind: MEDIA },
  ".mov": { mime: "video/quicktime", kind: MEDIA },
  ".mp3": { mime: "audio/mpeg", kind: MEDIA },
  ".m4a": { mime: "audio/mp4", kind: MEDIA },
  ".wav": { mime: "audio/wav", kind: MEDIA },
  ".ogg": { mime: "audio/ogg", kind: MEDIA },
  ".png": { mime: "image/png", kind: MEDIA },
  ".jpg": { mime: "image/jpeg", kind: MEDIA },
  ".jpeg": { mime: "image/jpeg", kind: MEDIA },
  ".webp": { mime: "image/webp", kind: MEDIA },
  ".gif": { mime: "image/gif", kind: MEDIA },
  ".json": { mime: "application/json", kind: FILE },
  ".txt": { mime: "text/plain; charset=utf-8", kind: FILE },
  ".log": { mime: "text/plain; charset=utf-8", kind: FILE },
  ".srt": { mime: "text/plain; charset=utf-8", kind: FILE },
  ".vtt": { mime: "text/vtt; charset=utf-8", kind: FILE },
};

function baseHeaders(type: { mime: string; kind: string }, parts: string[]): Record<string, string> {
  const h: Record<string, string> = {
    "content-type": type.mime,
    "x-content-type-options": "nosniff",
    "cache-control": "private, no-store",
    "accept-ranges": "bytes",
    "cross-origin-resource-policy": "same-origin",
  };
  if (type.kind !== MEDIA) h["content-disposition"] = `attachment; filename="${parts[parts.length - 1]!.replace(/[^A-Za-z0-9._-]/g, "_")}"`;
  return h;
}

const NO_STORE = { "cache-control": "no-store" };
// One body for every refusal before the signature is proven: nothing here depends on whether the file exists.
const forbidden = () => Response.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
const notFound = () => Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
const unavailable = () => Response.json({ error: "unavailable" }, { status: 503, headers: NO_STORE });

type Range = { kind: "none" } | { kind: "bad" } | { kind: "ok"; start: number; end: number };

/** Single byte range only. Anything else (several ranges, other units, junk, out of bounds) is "bad" and becomes a 416. */
function parseRange(header: string | null, size: number): Range {
  if (header === null) return { kind: "none" };
  const m = /^bytes=(\d{0,15})-(\d{0,15})$/.exec(header);
  if (!m || (m[1] === "" && m[2] === "")) return { kind: "bad" };
  if (m[1] === "") {
    const n = Number(m[2]);
    if (n === 0 || size === 0) return { kind: "bad" };
    return { kind: "ok", start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size || (m[2] !== "" && Number(m[2]) < start)) return { kind: "bad" };
  return { kind: "ok", start, end };
}

/**
 * The file must be a regular file whose real path is exactly root + parts: no symlink anywhere on the way (a render
 * container could plant one), nothing outside the root. Opened with O_NOFOLLOW (final component swapped to a link after
 * the check) and O_NONBLOCK (a FIFO planted in its place must not hang the server), then re-checked with fstat.
 * Directory swaps between the check and the open remain a theoretical race; writers are our own code and sandboxes.
 */
async function openRegularFile(parts: string[]): Promise<{ fh: Awaited<ReturnType<typeof open>>; size: number } | null> {
  try {
    const root = storageRoot();
    const target = await safeJoin(root, ...parts);
    const expected = path.join(await realpath(root), ...parts);
    if ((await realpath(target)) !== expected) return null;
    const fh = await open(expected, fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK);
    const st = await fh.stat();
    if (!st.isFile()) {
      await fh.close();
      return null;
    }
    return { fh, size: st.size };
  } catch {
    return null;
  }
}
