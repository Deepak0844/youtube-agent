import { assertAllowedHost } from "@/lib/auth/origin";
import { requireOwnerApi } from "@/lib/auth/require-owner";
import { getPool } from "@/server/db/pool";
import { latestEventId, listEventsSince } from "@/server/db/events";
import { getEventBus } from "@/server/queue/event-bus";
import { createEventStream } from "@/server/queue/event-stream";

// Live feed (server-sent events). Deliberately OUTSIDE proxy.ts (a long-lived stream), so this handler does the session
// check and the Host check itself, before opening anything. The session is the credential; it is read from the cookie only.
// Resume: Last-Event-ID (sent by EventSource on reconnect) wins over ?since=. With neither, the feed starts at "now".
const noStore = { "cache-control": "no-store" };
const bad = (error: string) => Response.json({ error }, { status: 400, headers: noStore });

function cursor(raw: string | null): number | null | undefined {
  if (raw === null || raw === "") return undefined;
  return /^\d{1,15}$/.test(raw) ? Number(raw) : null; // null = malformed
}

export async function GET(request: Request) {
  const owner = await requireOwnerApi(request);
  if (owner instanceof Response) return owner;
  const hostErr = assertAllowedHost(request);
  if (hostErr) return hostErr;

  const fromHeader = cursor(request.headers.get("last-event-id"));
  const fromQuery = cursor(new URL(request.url).searchParams.get("since"));
  if (fromHeader === null || fromQuery === null) return bad("bad_cursor");

  const db = getPool();
  const startId = fromHeader ?? fromQuery ?? (await latestEventId(db));
  const bus = getEventBus();
  const stream = createEventStream({
    startId,
    signal: request.signal,
    fetchSince: (after, limit) => listEventsSince(db, after, limit),
    subscribe: bus ? (wake) => bus.subscribe(wake) : undefined,
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
