"use client";

import { useActionState, useState } from "react";
import { Button } from "@/ui/primitives/button";
import { evidenceAction, type EvidenceState } from "./evidence-actions";

export interface ClaimRow { text: string; kind: "sourced" | "computed"; source_url: string; quote: string; method: string }
const FIELD = "w-full rounded-control border border-control bg-ground px-3 py-2 text-body";
const blank = (): ClaimRow => ({ text: "", kind: "sourced", source_url: "", quote: "", method: "" });
const toWire = (r: ClaimRow) => (r.kind === "sourced" ? { text: r.text, kind: "sourced", source_url: r.source_url, quote: r.quote } : { text: r.text, kind: "computed", method: r.method });

/** Claim editor: add, remove, change kind. "Save and verify" and "Re-verify" both send the claims to the server, which checks them and HEADs each link. */
export function EvidenceEditor({ videoId, initial, verified }: { videoId: string; initial: ClaimRow[]; verified: boolean }) {
  const [rows, setRows] = useState<ClaimRow[]>(initial);
  const [state, run, pending] = useActionState<EvidenceState, FormData>(evidenceAction, {});
  const set = (i: number, patch: Partial<ClaimRow>) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <form action={run} data-testid="evidence-form" className="flex min-w-0 flex-col gap-4">
      <input type="hidden" name="videoId" value={videoId} />
      <input type="hidden" name="claims" value={JSON.stringify(rows.map(toWire))} />
      <ol className="m-0 flex list-none flex-col gap-4 p-0">
        {rows.map((r, i) => (
          <li key={i} data-testid="claim-row" className="flex min-w-0 flex-col gap-2 rounded-card bg-surface p-pad">
            <label className="flex flex-col gap-1 text-small text-muted">Claim
              <input aria-label={`Claim ${i + 1} text`} value={r.text} onChange={(e) => set(i, { text: e.target.value })} className={FIELD} />
            </label>
            <label className="flex flex-col gap-1 text-small text-muted">Kind
              <select aria-label={`Claim ${i + 1} kind`} value={r.kind} onChange={(e) => set(i, { kind: e.target.value as ClaimRow["kind"] })} className={FIELD}>
                <option value="sourced">Sourced (link)</option>
                <option value="computed">Computed (method)</option>
              </select>
            </label>
            {r.kind === "sourced" ? (
              <>
                <label className="flex flex-col gap-1 text-small text-muted">Link
                  <input aria-label={`Claim ${i + 1} link`} value={r.source_url} onChange={(e) => set(i, { source_url: e.target.value })} className={FIELD} inputMode="url" />
                </label>
                <label className="flex flex-col gap-1 text-small text-muted">Quote from the source
                  <input aria-label={`Claim ${i + 1} quote`} value={r.quote} onChange={(e) => set(i, { quote: e.target.value })} className={FIELD} />
                </label>
              </>
            ) : (
              <label className="flex flex-col gap-1 text-small text-muted">How it was computed
                <input aria-label={`Claim ${i + 1} method`} value={r.method} onChange={(e) => set(i, { method: e.target.value })} className={FIELD} />
              </label>
            )}
            <div><Button variant="ghost" onClick={() => setRows((x) => x.filter((_, j) => j !== i))}>Remove claim {i + 1}</Button></div>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" onClick={() => setRows((x) => [...x, blank()])}>Add claim</Button>
        <Button type="submit" disabled={pending}>{verified ? "Re-verify" : "Save and verify"}</Button>
        <Button type="submit" variant="ghost" name="intent" value="reseed" disabled={pending}>Start again from the script</Button>
      </div>
      <p className="m-0 text-small text-muted">Verify checks each link with a quick, safe request (public web addresses only, 10 links at most, one try each). Only you can do this.</p>
      {state.message ? <p role={state.ok ? "status" : "alert"} className={state.ok ? "m-0 text-body text-pill-positive-ink" : "m-0 text-body text-pill-negative-ink"}>{state.message}</p> : null}
    </form>
  );
}
