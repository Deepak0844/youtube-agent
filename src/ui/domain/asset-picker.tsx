"use client";

import { useEffect, useState, useTransition } from "react";
import { searchAssetsAction } from "@/app/(app)/assets/actions";
import { UploadZone } from "@/app/(app)/assets/upload-zone";
import type { AssetCard } from "@/server/db/asset-cards";
import { Button } from "../primitives/button";
import { Input } from "../primitives/input";

/** Choose existing files: search, the most recent first, and an upload button that opens the upload area. */
export function AssetPicker({ kind, multiple = false, onPick }: { kind?: "image" | "audio"; multiple?: boolean; onPick: (ids: string[]) => void }) {
  const [q, setQ] = useState("");
  const [cards, setCards] = useState<AssetCard[] | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [version, setVersion] = useState(0);
  const [, start] = useTransition();

  useEffect(() => {
    const t = setTimeout(() => start(async () => setCards(await searchAssetsAction(kind, q))), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [kind, q, version]);

  const choose = (id: string) => {
    if (!multiple) return onPick([id]);
    setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  };

  return (
    <div className="flex min-w-0 flex-col gap-gap">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Input type="search" aria-label="Search files" placeholder="Search by name" value={q} onChange={(e) => setQ(e.target.value)} maxLength={100} className="sm:max-w-xs" />
        <Button variant="secondary" onClick={() => setUploading((u) => !u)}>
          Upload
        </Button>
      </div>
      {uploading ? <UploadZone onDone={() => setVersion((v) => v + 1)} /> : null}
      {cards === null ? (
        <p role="status" className="text-body text-muted">
          Loading…
        </p>
      ) : cards.length === 0 ? (
        <p className="text-body text-muted">{q ? "No files match that name." : "No files yet. Use Upload to add some."}</p>
      ) : (
        <ul className="grid min-w-0 grid-cols-2 gap-2 md:grid-cols-4">
          {cards.map((c) => (
            <li key={c.id}>
              <button type="button" aria-pressed={chosen.includes(c.id)} onClick={() => choose(c.id)} className="flex min-h-11 w-full min-w-0 flex-col gap-1 rounded-card bg-surface p-2 text-left aria-pressed:bg-raised aria-pressed:outline aria-pressed:outline-2 aria-pressed:outline-text">
                {c.kind === "image" && c.url ? (
                  // eslint-disable-next-line @next/next/no-img-element -- a signed media URL
                  <img src={c.url} alt="" loading="lazy" className="aspect-square w-full rounded-control object-cover" />
                ) : (
                  <span className="flex aspect-square w-full items-center justify-center rounded-control bg-raised text-small text-muted">Sound</span>
                )}
                <span className="truncate text-small">{c.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {multiple ? (
        <div>
          <Button disabled={chosen.length === 0} onClick={() => onPick(chosen)}>
            Use {chosen.length || ""} chosen
          </Button>
        </div>
      ) : null}
    </div>
  );
}
