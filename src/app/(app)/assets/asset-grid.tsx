"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import type { AssetCard } from "@/server/db/asset-cards";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from "@/ui/primitives/alert-dialog";
import { Button } from "@/ui/primitives/button";
import { Checkbox } from "@/ui/primitives/checkbox";
import { Input } from "@/ui/primitives/input";
import { Pill } from "@/ui/primitives/pill";
import { restoreAction, tagAction, trashAction } from "./actions";

/** The cards, with pick boxes for bulk tag and delete. In the trash view each card has Restore instead. */
export function AssetGrid({ cards, trash }: { cards: AssetCard[]; trash: boolean }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [tag, setTag] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState("");
  const [pending, start] = useTransition();
  const anyKeep = cards.some((c) => c.keep && picked.includes(c.id));
  const toggle = (id: string, on: boolean) => setPicked((p) => (on ? [...p, id] : p.filter((x) => x !== id)));

  const run = (f: () => Promise<{ ok: boolean; message?: string; keptBlocked?: string[] }>, done: string) =>
    start(async () => {
      const r = await f();
      setMessage(r.ok ? done : (r.message ?? ("keptBlocked" in r && r.keptBlocked ? "Some files are marked Keep. Try again and confirm." : "Could not do that. Nothing was changed.")));
      if (r.ok) setPicked([]);
    });

  return (
    <div className="flex min-w-0 flex-col gap-gap">
      {!trash && picked.length ? (
        <div className="flex min-w-0 flex-wrap items-end gap-3 rounded-card bg-surface p-pad">
          <span className="text-body">{picked.length} chosen</span>
          <Input aria-label="Tag to add" value={tag} onChange={(e) => setTag(e.target.value)} maxLength={60} className="sm:max-w-48" />
          <Button variant="secondary" disabled={pending || !tag.trim()} onClick={() => run(() => tagAction(picked, [tag.trim()]), "Tag added.")}>
            Add tag
          </Button>
          <Button variant="destructive" disabled={pending} onClick={() => setConfirming(true)}>
            Delete selected
          </Button>
        </div>
      ) : null}
      <p role="status" aria-live="polite" className="min-h-5 text-small text-muted">
        {message}
      </p>
      <ul className="grid min-w-0 grid-cols-2 gap-gap md:grid-cols-4 xl:grid-cols-6">
        {cards.map((c) => (
          <li key={c.id} data-asset={c.id} className="flex min-w-0 flex-col gap-2 rounded-card bg-surface p-3">
            <Link href={`/assets/${c.id}`} className="block aspect-square overflow-hidden rounded-control bg-raised">
              {c.kind === "image" && c.url ? (
                // eslint-disable-next-line @next/next/no-img-element -- a signed media URL, not an optimisable static import
                <img src={c.url} alt="" loading="lazy" className="size-full object-cover" />
              ) : (
                <span className="flex size-full items-center justify-center text-small text-muted">{c.kind === "audio" ? "Sound" : "No preview"}</span>
              )}
            </Link>
            <div className="flex min-w-0 items-start gap-2">
              {!trash ? <Checkbox aria-label={`Choose ${c.name}`} checked={picked.includes(c.id)} onCheckedChange={(v) => toggle(c.id, v === true)} /> : null}
              <span className="min-w-0 truncate text-small">{c.name}</span>
            </div>
            <div className="flex min-w-0 flex-wrap gap-1">
              {c.keep ? <Pill tone="positive">Keep</Pill> : null}
              {c.tags.map((t) => (
                <Pill key={t}>{t}</Pill>
              ))}
            </div>
            {trash ? (
              <>
                <p className="text-small text-muted">Removed for good on {c.purgeAt?.slice(0, 10)}</p>
                <Button variant="secondary" disabled={pending} onClick={() => run(() => restoreAction(c.id), "Restored.")}>
                  Restore
                </Button>
              </>
            ) : null}
          </li>
        ))}
      </ul>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogTitle>Move {picked.length === 1 ? "this file" : `${picked.length} files`} to the trash?</AlertDialogTitle>
          <AlertDialogDescription>
            Which videos use these files is not tracked yet. {anyKeep ? "Some of these are marked Keep, and Keep files are normally never deleted. " : ""}
            They stay in the trash for 7 days and can be restored until then.
          </AlertDialogDescription>
          <div className="flex flex-wrap justify-end gap-2">
            <AlertDialogCancel>Not now</AlertDialogCancel>
            <AlertDialogAction onClick={() => run(() => trashAction(picked, anyKeep), "Moved to the trash.")}>Move to trash</AlertDialogAction>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
