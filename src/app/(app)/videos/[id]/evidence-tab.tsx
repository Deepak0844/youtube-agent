import { loadEvidence } from "@/server/db/evidence";
import { getPool } from "@/server/db/pool";
import type { VideoPage } from "@/server/db/video-page";
import { Pill } from "@/ui/primitives/pill";
import { EvidenceEditor, type ClaimRow } from "./evidence-form";

const str = (v: unknown): string => (typeof v === "string" ? v : "");

// The Evidence tab: the claims behind the script, editable by the owner, with the result of the last check.
export async function EvidenceTabPanel({ p }: { p: VideoPage }) {
  const ev = await loadEvidence(getPool(), p.head.id);
  const rows: ClaimRow[] = ev.claims.map((c) => {
    const o = c as unknown as Record<string, unknown>;
    return { text: str(o.text), kind: o.kind === "computed" ? "computed" : "sourced", source_url: str(o.source_url), quote: str(o.quote), method: str(o.method) };
  });
  const v = ev.verification;
  return (
    <>
      {ev.verifiedNow ? <Pill tone="positive">Verified {v ? v.at.slice(0, 16).replace("T", " ") + " UTC" : ""}</Pill> : <Pill tone="warning">Not verified</Pill>}
      {v && !ev.verifiedNow && v.problems.length > 0 ? (
        <ul data-testid="evidence-problems" className="m-0 list-disc pl-5 text-small text-pill-negative-ink">{v.problems.map((x, i) => <li key={i} className="[overflow-wrap:anywhere]">{x}</li>)}</ul>
      ) : null}
      {v && ev.verifiedNow ? <p className="m-0 text-small text-muted">{v.results.length} link(s) answered.</p> : null}
      {rows.length === 0 ? <p className="m-0 max-w-[60ch] text-body text-muted">No evidence yet. Add a claim, or start again from the script.</p> : null}
      <EvidenceEditor key={JSON.stringify(rows)} videoId={p.head.id} initial={rows} verified={ev.verifiedNow || v !== null} />
      {p.evidence?.fileSrc ? <a className="text-body underline" href={p.evidence.fileSrc} target="_blank" rel="noreferrer">Open the evidence file</a> : null}
    </>
  );
}
