import { assertAllowedHost } from "@/lib/auth/origin";
import { requireTokenApi } from "@/lib/auth/require-token";
import { createDraftForToken } from "@/server/db/api-tokens";
import { getPool } from "@/server/db/pool";

// Creates one draft video (nothing runs, nothing is approved or published). Scope: create_draft. Capped per token per IST day.
const noStore = { "cache-control": "no-store" };

export async function POST(request: Request) {
  const hostErr = assertAllowedHost(request);
  if (hostErr) return hostErr;
  const t = await requireTokenApi(request, "create_draft");
  if (t instanceof Response) return t;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "bad_json" }, { status: 400, headers: noStore });
  }
  const o = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const topic = typeof o.topic === "string" ? o.topic.trim() : "";
  const notes = typeof o.notes === "string" ? o.notes.trim().slice(0, 2000) : null;
  if (topic.length < 1 || topic.length > 200) return Response.json({ error: "bad_topic" }, { status: 400, headers: noStore });
  const r = await createDraftForToken(getPool(), t, { topic, notes });
  if (!r.ok) return Response.json({ error: "daily_cap_reached" }, { status: 429, headers: noStore });
  return Response.json({ id: r.video.id, status: r.video.status }, { status: 201, headers: noStore });
}
