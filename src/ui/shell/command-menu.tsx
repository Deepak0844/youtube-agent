"use client";

import { Command } from "cmdk";
import { Clapperboard, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { searchVideosAction } from "@/app/_actions/search";
import { cn, fade, focusRing } from "../lib/cn";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "../primitives/dialog";
import { AREA_ICONS } from "./rail";
import { visibleAreas } from "./nav-config";

const pages = visibleAreas().flatMap((a) => a.items.map((i) => ({ ...i, label: a.area === "Settings" && i.label === "Assets" ? "Asset settings" : i.label })));
const row = "flex min-h-11 cursor-default items-center gap-3 rounded-control px-2 text-body text-text data-[selected=true]:bg-raised sm:min-h-10";
const chip = "flex size-7 shrink-0 items-center justify-center rounded-control border border-border bg-page text-muted";
const group = "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1.5 [&_[cmdk-group-heading]]:text-small [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-faint";
const key = "min-w-5 rounded-[4px] border border-border bg-page px-1 text-center font-sans text-[11px] text-muted";

/** Search or jump to (spec §2): ⌘K / Ctrl+K or the top-bar button. Pages from the menu, videos by title. */
export function CommandMenu() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [videos, setVideos] = useState<Array<{ id: string; title: string; format: string }>>([]);
  const router = useRouter();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!q.trim()) return;
    let live = true;
    const t = setTimeout(() => void searchVideosAction(q).then((r) => live && setVideos(r)).catch(() => live && setVideos([])), 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q]);

  const go = (href: string) => {
    setOpen(false);
    setQ("");
    router.push(href);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn("flex h-8 w-56 items-center gap-2 rounded-control border border-border bg-surface px-2.5 text-body text-faint hover:text-muted", fade, focusRing)}
      >
        <Search size={14} aria-hidden />
        <span className="flex-1 text-left">Search or jump to…</span>
        <kbd className="rounded-[4px] border border-border px-1 font-sans text-small">⌘K</kbd>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent hideClose className="top-[14vh] max-w-xl translate-y-0 gap-0 overflow-hidden !p-0">
          <DialogTitle className="sr-only">Search or jump to</DialogTitle>
          <DialogDescription className="sr-only">Type a page name or a video title, then press Enter.</DialogDescription>
          <Command label="Search or jump to" shouldFilter className="flex flex-col">
            <div className="flex items-center gap-3 border-b border-border px-4">
              <Search size={16} aria-hidden className="shrink-0 text-muted" />
              <Command.Input
                value={q}
                onValueChange={(v) => {
                  setQ(v);
                  if (!v.trim()) setVideos([]);
                }}
                placeholder="Search pages and videos…"
                // The whole row is the field: the page-wide focus outline would draw a second box inside it.
                style={{ outline: "none" }}
                className="h-14 min-w-0 flex-1 bg-transparent text-section text-text outline-none placeholder:text-faint focus-visible:outline-none"
              />
              <DialogClose className={cn("rounded-[5px] border border-border px-1.5 py-0.5 text-small text-muted hover:text-text", focusRing)}>Esc</DialogClose>
            </div>
            <Command.List className="max-h-[min(60vh,26rem)] overflow-y-auto p-2">
              <Command.Empty className="flex flex-col items-center gap-1 px-3 py-10 text-center">
                <span className="text-body font-medium">Nothing matches “{q}”</span>
                <span className="text-small text-muted">Try a page name like “Keys”, or part of a video title.</span>
              </Command.Empty>
              {videos.length > 0 && (
                <Command.Group heading="Videos" className={group}>
                  {videos.map((v) => (
                    <Command.Item key={v.id} value={`${v.title} ${v.id}`} keywords={[q]} onSelect={() => go(`/videos/${v.id}`)} className={row}>
                      <span className={chip}>
                        <Clapperboard size={14} aria-hidden />
                      </span>
                      <span className="min-w-0 flex-1 truncate">{v.title}</span>
                      <span className="text-small text-faint">{v.format === "long" ? "Long" : "Short"}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              <Command.Group heading="Pages" className={group}>
                {pages.map((p) => {
                  const Icon = AREA_ICONS[p.area];
                  return (
                    <Command.Item key={p.href} value={`${p.label} ${p.area}`} onSelect={() => go(p.href)} className={row}>
                      <span className={chip}>
                        <Icon size={14} aria-hidden />
                      </span>
                      <span className="flex-1">{p.label}</span>
                      <span className="text-small text-faint">{p.area}</span>
                    </Command.Item>
                  );
                })}
              </Command.Group>
            </Command.List>
            <div className="flex items-center gap-4 border-t border-border bg-raised/40 px-4 py-2 text-small text-faint">
              <span className="flex items-center gap-1.5"><kbd className={key}>↑</kbd><kbd className={key}>↓</kbd> move</span>
              <span className="flex items-center gap-1.5"><kbd className={key}>↵</kbd> open</span>
              <span className="flex items-center gap-1.5"><kbd className={key}>esc</kbd> close</span>
            </div>
          </Command>
        </DialogContent>
      </Dialog>
    </>
  );
}
