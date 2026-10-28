"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

// The live feed for /queue: a server-sent-events connection to /api/events that re-renders the server page (router.refresh,
// no reload) when something the page shows may have changed. It closes when the tab is hidden, reopens from the last event
// it saw when the tab is visible again, and a slow timer covers a dead stream. Postgres is the truth; this only says "look now".
const TYPES = [
  "stage.started", "stage.succeeded", "stage.failed", "stage.needs_decision", "stage.cancelled",
  "gate.waiting", "gate.approved", "gate.sent_back", "video.created", "video.done", "video.failed",
] as const;
const FALLBACK_MS = 20_000;
const DEBOUNCE_MS = 250;

export function LiveFeed() {
  const router = useRouter();
  const [state, setState] = useState<"connecting" | "live" | "paused">("connecting");
  const lastId = useRef<string | null>(null);

  useEffect(() => {
    let es: EventSource | null = null;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    let fallback: ReturnType<typeof setInterval> | undefined;
    const refresh = () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => router.refresh(), DEBOUNCE_MS);
    };
    const open = () => {
      if (es) return;
      const since = lastId.current;
      es = new EventSource(since ? `/api/events?since=${encodeURIComponent(since)}` : "/api/events");
      es.onopen = () => setState("live");
      es.onerror = () => setState("connecting"); // EventSource reconnects by itself, sending Last-Event-ID
      for (const t of TYPES) {
        es.addEventListener(t, (e) => {
          lastId.current = (e as MessageEvent).lastEventId || lastId.current;
          refresh();
        });
      }
      fallback = setInterval(() => router.refresh(), FALLBACK_MS);
    };
    const close = () => {
      es?.close();
      es = null;
      clearInterval(fallback);
      clearTimeout(debounce);
      setState("paused");
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") close();
      else {
        open();
        router.refresh(); // catch up on what happened while hidden
      }
    };
    if (document.visibilityState !== "hidden") open();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      close();
    };
  }, [router]);

  return (
    <p data-testid="live-feed" data-state={state} className="m-0 text-small text-faint">
      {state === "live" ? "Live: this page updates by itself." : state === "paused" ? "Paused while this tab is hidden." : "Connecting to live updates..."}
    </p>
  );
}
