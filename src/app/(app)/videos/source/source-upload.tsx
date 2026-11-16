"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { LANGUAGE_ORDER, LANGUAGE_WORDS } from "@/server/core/videos-view";
import { Button } from "@/ui/primitives/button";
import { Label } from "@/ui/primitives/label";
import { cn, control, fade, focusRing } from "@/ui/lib/cn";

const selectClass = cn("w-full rounded-control border border-control bg-surface px-3 text-body text-text disabled:opacity-50", control, fade, focusRing);
const MAX_BYTES = 1024 * 1024 * 1024;

type Phase = { kind: "idle" } | { kind: "sending"; percent: number } | { kind: "error"; message: string };

/** One video file, streamed to the server with progress. On success the video's own page opens (its Clips tab shows the preparation). */
export function SourceUpload() {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const xhr = useRef<XMLHttpRequest | null>(null);
  const [language, setLanguage] = useState("en");
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const sending = phase.kind === "sending";

  const pick = (f: File | null) => {
    setFile(f);
    setPhase(f && f.size > MAX_BYTES ? { kind: "error", message: "This file is over 1 GB." } : { kind: "idle" });
  };

  const send = () => {
    if (!file || file.size > MAX_BYTES || file.size === 0) return;
    const x = new XMLHttpRequest();
    xhr.current = x;
    x.open("POST", `/api/clip-sources?language=${encodeURIComponent(language)}`);
    x.setRequestHeader("x-file-name", encodeURIComponent(file.name));
    x.upload.onprogress = (e) => e.lengthComputable && setPhase({ kind: "sending", percent: Math.round((100 * e.loaded) / e.total) });
    x.onerror = () => setPhase({ kind: "error", message: "The upload was interrupted. Try again." });
    x.onabort = () => setPhase({ kind: "idle" });
    x.onload = () => {
      let body: { videoId?: unknown; message?: unknown } = {};
      try {
        body = JSON.parse(x.responseText) as typeof body;
      } catch {
        /* not JSON */
      }
      if (x.status === 201 && typeof body.videoId === "string") router.push(`/videos/${body.videoId}?tab=clips`);
      else setPhase({ kind: "error", message: typeof body.message === "string" ? body.message : "The upload was refused." });
    };
    setPhase({ kind: "sending", percent: 0 });
    x.send(file);
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); send(); }} className="flex min-w-0 flex-col gap-4">
      <div className="flex min-w-0 flex-col gap-1.5">
        <Label htmlFor="clip-language">Language spoken in the video</Label>
        <select id="clip-language" value={language} onChange={(e) => setLanguage(e.target.value)} disabled={sending} className={selectClass}>
          {LANGUAGE_ORDER.map((l) => <option key={l} value={l}>{LANGUAGE_WORDS[l]}</option>)}
        </select>
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        <Label htmlFor="clip-file">Video file</Label>
        <input ref={input} id="clip-file" type="file" accept="video/mp4,video/quicktime,video/x-matroska,video/webm,.mp4,.mov,.mkv,.webm" disabled={sending} onChange={(e) => pick(e.target.files?.[0] ?? null)} className="text-body" />
        <p className="m-0 text-small text-muted">mp4, mov, mkv or webm, at most 1 GB and 30 minutes, at least about 22 seconds.</p>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <Button type="submit" disabled={!file || sending || (file?.size ?? 0) > MAX_BYTES}>Upload and prepare</Button>
        {sending ? <Button type="button" variant="secondary" onClick={() => xhr.current?.abort()}>Cancel</Button> : null}
        {sending ? <p role="status" className="m-0 text-body tabular-nums text-muted">Uploading {phase.percent}%</p> : null}
      </div>
      {phase.kind === "error" ? <p role="alert" className="m-0 text-body text-pill-negative-ink">{phase.message}</p> : null}
    </form>
  );
}
