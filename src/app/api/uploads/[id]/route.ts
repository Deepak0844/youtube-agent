import { assertAllowedHost } from "@/lib/auth/origin";
import { requireOwnerApi } from "@/lib/auth/require-owner";
import { getIngestJob } from "@/server/db/ingest-jobs";
import { getPool } from "@/server/db/pool";

// GET /api/uploads/<id>: where one upload is (session only; outside proxy.ts like its parent). The file name is shown
// HTML-escaped, so a name such as <img onerror=...> can never run if a page prints this field as markup.
const noStore = { "cache-control": "no-store" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: Request, ctx: Ctx): Promise<Response> {
  const owner = await requireOwnerApi(request);
  if (owner instanceof Response) return owner;
  const bad = assertAllowedHost(request);
  if (bad) return bad;
  const { id } = await ctx.params;
  const job = UUID.test(id) ? await getIngestJob(getPool(), id) : null;
  if (!job) return Response.json({ error: "not_found" }, { status: 404, headers: noStore });
  const status = job.status === "done" || job.status === "rejected" ? job.status : "queued";
  return Response.json(
    { status, name: [...job.originalName].map((c) => ESCAPES[c] ?? c).join(""), ...(job.assetId && { assetId: job.assetId }), ...(job.reason && { reason: job.reason }) },
    { headers: noStore },
  );
}
