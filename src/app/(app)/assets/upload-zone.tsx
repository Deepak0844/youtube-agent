"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/ui/primitives/button";
import { Checkbox } from "@/ui/primitives/checkbox";
import { Label } from "@/ui/primitives/label";
import { UploadRow } from "./upload-row";
import { decodeName, heicRefusal, type UploadState } from "./upload-status";

interface Item {
  key: string;
  file: File;
  name: string;
  state: UploadState;
  percent: number;
  message?: string;
}

const RIGHTS_TEXT = "I have the rights to use this";
const POLL_MS = 1500;
const ACCEPT = "image/jpeg,image/png,image/webp,image/gif,audio/*,.heic,.heif";

/** Drag and drop, file picker and clipboard paste in one list. One rights tick for the batch; person and voice consent are asked separately. */
export function UploadZone({ onDone }: { onDone?: () => void }) {
  const router = useRouter();
  const uid = useId();
  const [items, setItems] = useState<Item[]>([]);
  const [rights, setRights] = useState(false);
  const [person, setPerson] = useState(false);
  const [likeness, setLikeness] = useState(false);
  const [voice, setVoice] = useState(false);
  const [voiceOk, setVoiceOk] = useState(false);
  const [over, setOver] = useState(false);
  const xhrs = useRef(new Map<string, XMLHttpRequest>());
  const alive = useRef(true);
  const patch = useCallback((key: string, p: Partial<Item>) => setItems((cur) => cur.map((i) => (i.key === key ? { ...i, ...p } : i))), []);

  useEffect(() => {
    alive.current = true;
    const xs = xhrs.current;
    return () => {
      alive.current = false;
      xs.forEach((x) => x.abort());
    };
  }, []);

  const add = useCallback((files: File[]) => {
    setItems((cur) => [
      ...cur,
      ...files.map((file): Item => {
        const refusal = heicRefusal(file);
        return { key: crypto.randomUUID(), file, name: file.name, state: refusal ? "failed" : "ready", percent: 0, message: refusal ?? undefined };
      }),
    ]);
  }, []);

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const pics = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
      if (pics.length) add(pics);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [add]);

  const watch = useCallback(
    async (key: string, id: string) => {
      while (alive.current) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        if (!alive.current) return;
        try {
          const res = await fetch(`/api/uploads/${id}`, { cache: "no-store" });
          const s = (await res.json()) as { status?: string; name?: string; reason?: string };
          if (s.status === "done") return patch(key, { state: "done", ...(s.name && { name: decodeName(s.name) }) });
          if (s.status === "rejected") return patch(key, { state: "failed", message: s.reason ?? "The file was refused." });
        } catch {
          /* keep watching */
        }
      }
    },
    [patch],
  );

  const send = (item: Item, batch: string): Promise<void> =>
    new Promise((resolve) => {
      const x = new XMLHttpRequest();
      xhrs.current.set(item.key, x);
      x.open("POST", `/api/uploads?batch=${batch}`);
      x.setRequestHeader("x-file-name", encodeURIComponent(item.file.name));
      x.setRequestHeader(
        "x-rights",
        JSON.stringify({ text: RIGHTS_TEXT, contains_person: person, voice_clone: voice, ...(person && { consent_likeness: likeness }), ...(voice && { consent_voice: voiceOk }) }),
      );
      x.upload.onprogress = (e) => e.lengthComputable && patch(item.key, { percent: Math.round((e.loaded / e.total) * 100) });
      x.onload = () => {
        xhrs.current.delete(item.key);
        let body: { id?: string; message?: string } = {};
        try {
          body = JSON.parse(x.responseText);
        } catch {
          /* not JSON */
        }
        if (x.status === 201 && body.id) {
          patch(item.key, { state: "checking" });
          void watch(item.key, body.id).then(resolve);
        } else {
          patch(item.key, { state: "failed", message: body.message ?? "The upload did not go through. Try again." });
          resolve();
        }
      };
      x.onerror = () => {
        xhrs.current.delete(item.key);
        patch(item.key, { state: "failed", message: "The upload was interrupted. Try again." });
        resolve();
      };
      x.onabort = () => resolve();
      x.send(item.file);
    });

  const start = async () => {
    const batch = crypto.randomUUID();
    const ready = items.filter((i) => i.state === "ready");
    ready.forEach((i) => patch(i.key, { state: "sending", percent: 0 }));
    await Promise.all(ready.map((i) => send(i, batch)));
    if (!alive.current) return;
    (onDone ?? (() => router.refresh()))();
  };

  const cancel = (key: string) => {
    xhrs.current.get(key)?.abort();
    xhrs.current.delete(key);
    setItems((cur) => cur.filter((i) => i.key !== key));
  };

  const canSend = rights && (!person || likeness) && (!voice || voiceOk) && items.some((i) => i.state === "ready");
  const box = (id: string, label: string, v: boolean, set: (b: boolean) => void) => (
    <div className="flex min-h-11 items-center gap-3">
      <Checkbox id={id} checked={v} onCheckedChange={(c) => set(c === true)} />
      <Label htmlFor={id}>{label}</Label>
    </div>
  );

  return (
    <section aria-labelledby={`${uid}-h`} className="flex min-w-0 flex-col gap-gap rounded-card bg-surface p-pad">
      <h2 id={`${uid}-h`} className="text-title font-semibold">
        Add files
      </h2>
      <div
        data-over={over}
        onDragOver={(e) => (e.preventDefault(), setOver(true))}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => (e.preventDefault(), setOver(false), add([...e.dataTransfer.files]))}
        className="flex min-w-0 flex-col items-start gap-3 rounded-card border border-dashed border-control p-pad data-[over=true]:bg-raised"
      >
        <p className="text-body text-muted">Drop photos or sound files here, paste a picture, or choose files.</p>
        <label className="inline-flex min-h-11 cursor-pointer items-center rounded-control bg-raised px-4 text-body font-medium sm:min-h-9">
          Choose files
          <input type="file" multiple accept={ACCEPT} className="sr-only" onChange={(e) => (add([...(e.target.files ?? [])]), (e.target.value = ""))} />
        </label>
      </div>

      <div className="flex flex-col">
        {box(`${uid}-rights`, RIGHTS_TEXT, rights, setRights)}
        {box(`${uid}-person`, "A person is in it", person, setPerson)}
        {person ? box(`${uid}-likeness`, "They agreed to be shown", likeness, setLikeness) : null}
        {box(`${uid}-voice`, "It is a voice to copy", voice, setVoice)}
        {voice ? box(`${uid}-voiceok`, "The speaker agreed to this", voiceOk, setVoiceOk) : null}
      </div>

      {items.length ? (
        <ul className="flex min-w-0 flex-col gap-2" aria-label="Files to upload">
          {items.map((i) => (
            <UploadRow key={i.key} name={i.name} state={i.state} percent={i.percent} message={i.message} onCancel={() => cancel(i.key)} />
          ))}
        </ul>
      ) : null}
      <div>
        <Button onClick={start} disabled={!canSend}>
          Upload
        </Button>
      </div>
    </section>
  );
}
