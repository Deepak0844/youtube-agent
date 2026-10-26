import path from "node:path";
import { assertSameOrigin } from "@/lib/auth/origin";
import { requireOwnerApi } from "@/lib/auth/require-owner";
import { sinkUpload, UploadTooLargeError } from "@/server/providers/upload-sink";

// Streaming upload, deliberately OUTSIDE proxy.ts (the proxy buffers bodies up to 10 MB), so this handler does the
// session check and Host/Origin check itself, before a single body byte is read.
const noStore = { "cache-control": "no-store" };
const MAX_BYTES = Number(process.env.UPLOAD_MAX_BYTES ?? 2 * 1024 ** 3);

export async function POST(request: Request) {
  const owner = await requireOwnerApi(request); // the route guard checker wants the session check first
  if (owner instanceof Response) return owner;
  const bad = assertSameOrigin(request);
  if (bad) return bad;
  if (!request.body) return Response.json({ error: "empty_body" }, { status: 400, headers: noStore });
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BYTES) return Response.json({ error: "too_large" }, { status: 413, headers: noStore });
  try {
    const dir = path.resolve(process.env.UPLOAD_DIR ?? ".data/uploads");
    const r = await sinkUpload(request.body, { dir, maxBytes: MAX_BYTES, signal: request.signal });
    return Response.json(r, { status: 201, headers: noStore });
  } catch (err) {
    if (err instanceof UploadTooLargeError) return Response.json({ error: "too_large" }, { status: 413, headers: noStore });
    return Response.json({ error: "upload_failed" }, { status: 500, headers: noStore });
  }
}
