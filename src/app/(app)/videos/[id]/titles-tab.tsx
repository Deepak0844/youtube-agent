import type { Check } from "@/server/core/seo";
import { getPool } from "@/server/db/pool";
import { loadSeoTab } from "@/server/db/seo";
import { loadThumbnailTab } from "@/server/db/thumbnail";
import { loadChapterLines, loadUploadDetails } from "@/server/db/upload-details";
import type { VideoPage } from "@/server/db/video-page";
import { Pill } from "@/ui/primitives/pill";
import { UploadDetailsForm } from "./details-form";
import { ApproveThumbnailForm, MakeThumbnailForm } from "./thumbnail-forms";
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
// except the Regenerate button and the upload details form. Nothing is uploaded from here.
export async function TitlesTabPanel({ p }: { p: VideoPage }) {
  const t = await loadSeoTab(getPool(), p.head.id);
  const details = await loadUploadDetails(getPool(), p.head.id);
  const chapterLines = await loadChapterLines(getPool(), p.head.id);
  const thumb = p.head.format === "long" ? await loadThumbnailTab(getPool(), p.head.id) : null;
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
      {thumb ? (
        <>
          <H>Thumbnail</H>
          <p className="m-0 max-w-[68ch] text-small text-muted">A 1280x720 card with the title, on the video&apos;s own look. Pick one of your own pictures to put on it, or leave it empty. It is free and made on this computer. Approving it records your choice; it is not uploaded to YouTube from here.</p>
          {thumb.busy ? <p className="m-0 text-small text-muted">Drawing the thumbnail now.</p> : null}
          {!thumb.busy && thumb.failed ? <p role="alert" className="m-0 text-small text-pill-negative-ink">The last try failed (see the Log tab). Make it again to try once more.</p> : null}
          {thumb.src ? (
            // eslint-disable-next-line @next/next/no-img-element -- a signed media address of our own picture; next/image would need the host allow-listed
            <img data-testid="thumbnail-image" src={thumb.src} alt="The thumbnail card" width={640} height={360} className="h-auto max-w-full rounded-card bg-raised" />
          ) : thumb.hasCard ? <p className="m-0 text-small text-muted">The picture cannot be shown right now (the media key is locked).</p> : null}
          {thumb.hasCard && thumb.seenHash ? (thumb.approved ? <p data-testid="thumbnail-approved" className="m-0 text-body text-pill-positive-ink">You approved this thumbnail.</p> : <ApproveThumbnailForm key={thumb.seenHash} videoId={p.head.id} seenHash={thumb.seenHash} />) : null}
          <MakeThumbnailForm videoId={p.head.id} again={thumb.hasCard} disabled={thumb.busy} pictures={thumb.pictures} />
        </>
      ) : null}
      {details ? (
        <>
          <H>Upload details</H>
          <UploadDetailsForm key={JSON.stringify(details.saved ?? details.draft)} videoId={p.head.id} details={details.saved ?? details.draft} saved={details.saved !== null} channelTitle={details.channelTitle} chapterLines={chapterLines} />
        </>
      ) : null}
      <p className="m-0 text-small text-muted">Nothing is uploaded from here. Uploading arrives in the next step of Phase 5; saving these details only stores them with the video.</p>
    </>
  );
}
