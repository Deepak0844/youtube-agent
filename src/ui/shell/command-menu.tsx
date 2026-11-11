"use client";

import { Command } from "cmdk";
import { Clapperboard, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { searchVideosAction } from "@/app/_actions/search";
import { cn, fade, focusRing } from "../lib/cn";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../primitives/dialog";
import { AREA_ICONS } from "./rail";
import { visibleAreas } from "./nav-config";

const pages = visibleAreas().flatMap((a) => a.items.map((i) => ({ ...i, label: a.area === "Settings" && i.label === "Assets" ? "Asset settings" : i.label })));
const row = "flex min-h-11 cursor-default items-center gap-2.5 rounded-control px-2.5 text-body text-text data-[selected=true]:bg-raised sm:min-h-9";

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
        <DialogContent className="max-w-xl gap-0 p-0">
          <DialogTitle className="sr-only">Search or jump to</DialogTitle>
          <DialogDescription className="sr-only">Type a page name or a video title, then press Enter.</DialogDescription>
          <Command label="Search or jump to" shouldFilter={true} className="flex flex-col">
            <div className="flex items-center gap-2 border-b border-border px-3">
              <Search size={14} aria-hidden className="text-faint" />
              <Command.Input
                value={q}
                onValueChange={(v) => {
                  setQ(v);
                  if (!v.trim()) setVideos([]);
                }}
                placeholder="Search pages and videos…"
                className="h-12 flex-1 bg-transparent text-body text-text outline-none placeholder:text-faint"
              />
            </div>
            <Command.List className="max-h-80 overflow-y-auto p-1.5">
              <Command.Empty className="px-3 py-6 text-center text-body text-muted">Nothing matches.</Command.Empty>
              <Command.Group heading="Pages" className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-small [&_[cmdk-group-heading]]:text-faint">
                {pages.map((p) => {
                  const Icon = AREA_ICONS[p.area];
                  return (
                    <Command.Item key={p.href} value={`${p.label} ${p.area}`} onSelect={() => go(p.href)} className={row}>
                      <Icon size={14} aria-hidden className="text-muted" />
                      {p.label}
                      <span className="ml-auto text-small text-faint">{p.area}</span>
                    </Command.Item>
                  );
                })}
              </Command.Group>
              {videos.length > 0 && (
                <Command.Group heading="Videos" className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-small [&_[cmdk-group-heading]]:text-faint">
                  {videos.map((v) => (
                    <Command.Item key={v.id} value={`${v.title} ${v.id}`} keywords={[q]} onSelect={() => go(`/videos/${v.id}`)} className={row}>
                      <Clapperboard size={14} aria-hidden className="text-muted" />
                      <span className="truncate">{v.title}</span>
                      <span className="ml-auto text-small text-faint">{v.format === "long" ? "Long" : "Short"}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
            </Command.List>
          </Command>
        </DialogContent>
      </Dialog>
    </>
  );
}
