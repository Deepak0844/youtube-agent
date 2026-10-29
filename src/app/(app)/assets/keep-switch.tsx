"use client";

import { useState, useTransition } from "react";
import { Label } from "@/ui/primitives/label";
import { Switch } from "@/ui/primitives/switch";
import { setKeepAction } from "./actions";

export function KeepSwitch({ id, keep }: { id: string; keep: boolean }) {
  const [on, setOn] = useState(keep);
  const [error, setError] = useState("");
  const [pending, start] = useTransition();
  return (
    <div className="flex flex-col gap-1">
      <div className="flex min-h-11 items-center gap-3">
        <Switch
          id="keep"
          checked={on}
          disabled={pending}
          aria-label="Keep"
          onCheckedChange={(v) =>
            start(async () => {
              const r = await setKeepAction(id, v);
              if (r.ok) setOn(v);
              setError(r.ok ? "" : (r.message ?? "Could not change Keep."));
            })
          }
        />
        <Label htmlFor="keep">Keep this file</Label>
      </div>
      <p role="status" aria-live="polite" className="text-small text-muted">
        {error || (on ? "Never cleaned up automatically." : "Can be cleaned up when unused.")}
      </p>
    </div>
  );
}
