import { requireOwnerApi } from "@/lib/auth/require-owner";

export async function GET(request: Request) {
  const owner = await requireOwnerApi(request);
  if (owner instanceof Response) return owner;
  return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}
