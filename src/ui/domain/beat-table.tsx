import type { BeatRow } from "@/server/core/beat-rows";

// Read-only: what is said and what is on screen, per beat. Stacks as cards on phones.
export function BeatTable({ rows, shownForReal, style }: { rows: BeatRow[]; shownForReal?: string | null; style?: string | null }) {
  if (rows.length === 0) return null;
  return (
    <div data-testid="beat-table" className="flex min-w-0 flex-col gap-2">
      <h4 className="m-0 mt-2 text-small font-medium text-muted">Scenes ({rows.length}) and what is on screen</h4>
      <p className="m-0 text-small text-muted [overflow-wrap:anywhere]">Style: <span data-testid="beat-style">{style || "default"}</span></p>
      {shownForReal ? <p data-testid="shown-for-real" className="m-0 max-w-[68ch] text-body [overflow-wrap:anywhere]"><span className="text-muted">Shown for real: </span>{shownForReal}</p> : null}
      <ol className="m-0 flex list-none flex-col p-0">
        <li aria-hidden="true" className="hidden gap-3 border-b border-rule px-2 py-2 text-small text-faint sm:grid sm:grid-cols-[7rem_1fr_1fr]"><span>Beat</span><span>Voice says</span><span>On screen</span></li>
        {rows.map((r, i) => (
          <li key={i} className="grid min-w-0 gap-1 border-b border-rule px-2 py-3 sm:grid-cols-[7rem_1fr_1fr] sm:gap-3">
            <code className="font-mono text-small [overflow-wrap:anywhere]">{r.name}</code>
            <span className="text-body [overflow-wrap:anywhere]">{r.line}</span>
            <span className="text-body text-muted [overflow-wrap:anywhere]">{r.action || "No picture note"}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
