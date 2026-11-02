import type { Check } from "@/server/core/seo";
import { getPool } from "@/server/db/pool";
import { loadSeoTab } from "@/server/db/seo";
import type { VideoPage } from "@/server/db/video-page";
import { Pill } from "@/ui/primitives/pill";
import { CopyField, WriteTitlesForm } from "./titles-forms";

const H = ({ children }: { children: React.ReactNode }) => <h3 className="m-0 text-section font-medium">{children}</h3>;
const ANGLE: Record<string, string> = { clear: "Clear", curiosity: "Curiosity", number: "Number or surprise" };

function Marks({ checks }: { checks: Check[] }) {
  return (
    <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
      {checks.map((c) => <li key={c.id}><Pill tone={c.ok ? "positive" : "warning"}>{c.ok ? "OK" : "Check"}: {c.label}</Pill></li>)}
    </ul>
  );
}

// The Titles tab: three title options, the description, tags and a pinned-comment idea for the approved script. Read only
// except the Regenerate button. Nothing is uploaded from here.
export async function TitlesTabPanel({ p }: { p: VideoPage }) {
  const t = await loadSeoTab(getPool(), p.head.id);
  const lang = p.head.language;
  const b = t.body;
  return (
    <>
      <WriteTitlesForm videoId={p.head.id} again={b !== null} disabled={!t.canWrite || t.busy} />
      {!t.canWrite ? <p className="m-0 text-small text-muted">Approve the script first: the titles are written for the approved script.</p> : null}
      {t.busy ? <p className="m-0 text-small text-muted">Writing titles now.</p> : null}
      {!t.busy && p.runStatus.seo === "failed" ? <p role="alert" className="m-0 text-small text-pill-negative-ink">The last try failed (see the Log tab). Regenerate to try again.</p> : null}
      {t.stale ? <p data-testid="titles-stale" className="m-0 text-small text-pill-negative-ink">The script changed after these were written. Regenerate to match it.</p> : null}
      {b === null ? <p data-testid="empty" className="m-0 max-w-[60ch] rounded-card bg-surface p-pad text-body text-muted">No titles yet.</p> : (
        <>
          <H>Title options</H>
          <ol className="m-0 flex list-none flex-col gap-4 p-0">
            {b.options.map((o, i) => (
              <li key={i} data-testid="title-option" className="flex min-w-0 flex-col gap-1">
                <span className="text-small text-muted">{ANGLE[o.angle] ?? o.angle} <span className="tabular-nums">({[...o.text].length} characters)</span></span>
                <span lang={lang} className="text-body font-medium [overflow-wrap:anywhere]">{o.text}</span>
                <Marks checks={o.checks} />
                <div><CopyField value={o.text} label={`Copy title ${i + 1}`} /></div>
              </li>
            ))}
          </ol>

          <H>Description</H>
          <p lang={lang} className="m-0 max-w-[68ch] whitespace-pre-wrap text-body [overflow-wrap:anywhere]">{b.description}</p>
          <Marks checks={b.descriptionChecks} />
          <div><CopyField value={b.description} label="Copy description" /></div>

          <H>Tags</H>
          <p lang={lang} className="m-0 max-w-[68ch] text-body [overflow-wrap:anywhere]">{b.tags.join(", ")}</p>
          <p className="m-0 text-small text-muted">{b.tags.length} tags, {b.tags.join(",").length} of 450 characters.</p>
          <div><CopyField value={b.tags.join(", ")} label="Copy tags" /></div>

          <H>Pinned comment idea</H>
          <p lang={lang} className="m-0 max-w-[68ch] text-body [overflow-wrap:anywhere]">{b.pinnedComment}</p>
          <div><CopyField value={b.pinnedComment} label="Copy pinned comment" /></div>
        </>
      )}
      <p className="m-0 text-small text-muted">Uploading to YouTube comes later (Phase 5).</p>
    </>
  );
}
