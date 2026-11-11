"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export interface CutoutRow {
  id: string;
  status: "queued" | "running" | "done" | "failed";
  method: string;
  resultAssetId: string | null;
  error: string | null;
  when: string;
}

const WORDS = { queued: "Waiting", running: "Being made", done: "Done", failed: "Could not be made" } as const;

/** The picture's recent cut-outs. While one is waiting or being made, the page looks again every few seconds. */
export function CutoutList({ rows }: { rows: CutoutRow[] }) {
  const router = useRouter();
  const open = rows.some((r) => r.status === "queued" || r.status === "running");
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(t);
  }, [open, router]);
  if (rows.length === 0) return <p className="m-0 text-body text-muted">No cut-outs of this picture yet.</p>;
  return (
    <ul data-testid="cutout-list" className="m-0 flex list-none flex-col gap-2 p-0">
      {rows.map((r) => (
        <li key={r.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-body">
          <span className="font-medium">{WORDS[r.status]}</span>
          <span className="text-muted">{r.method === "white" ? "white background" : "background remover"} · {r.when}</span>
          {r.status === "done" && r.resultAssetId ? <Link href={`/assets/${r.resultAssetId}`} className="underline">Open the cut-out</Link> : null}
          {r.status === "failed" && r.error ? <span className="text-pill-negative-ink [overflow-wrap:anywhere]">{r.error}</span> : null}
        </li>
      ))}
    </ul>
  );
}
