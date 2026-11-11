import Link from "next/link";
import { Suspense } from "react";
import { requireOwner } from "@/lib/auth/require-owner";
import { FORMAT_WORDS, FORMATS, KIND_WORDS, KINDS, LANGUAGE_ORDER, LANGUAGE_WORDS, STATUSES, STATUS_WORDS, libraryHref, parseLibraryQuery, type LibraryFilter } from "@/server/core/videos-view";
import { getPool } from "@/server/db/pool";
import { loadInrRate } from "@/server/db/system-settings";
import { listVideos } from "@/server/db/videos-list";
import { Film } from "lucide-react";
import { clampPage, pageHref, parsePage } from "@/server/core/paging";
import { EmptyState } from "@/ui/states/empty-state";
import { PageSkeleton } from "@/ui/states/page-skeleton";
import { Pagination } from "@/ui/states/pagination";
import { TimeAgo } from "@/ui/states/time-ago";
import { Cell, DataHead, DataRow, DataTable, HeadCell, RowLink } from "@/ui/states/data-table";
import { formatUsd } from "@/ui/domain/spend-line";
import { Button } from "@/ui/primitives/button";
import { Pill } from "@/ui/primitives/pill";

export const metadata = { title: "Videos" };

// Videos (Doc 4 /videos, the old "Library"): every video, newest first, as a paged table. Filters, page and rows per
// page live in the address bar; changing a filter goes back to page 1.
export default function Library({ searchParams }: PageProps<"/videos">) {
  return (
    <Suspense fallback={<PageSkeleton variant="list" />}>
      <Owned searchParams={searchParams} />
    </Suspense>
  );
}

function Chips({ label, current, options }: { label: string; current: string | undefined; options: Array<[string, string | undefined, string]> }) {
  return (
    <nav aria-label={label} className="flex min-w-0 flex-wrap items-center gap-1.5">
      <span className="w-20 shrink-0 text-small text-muted">{label}</span>
      {options.map(([text, value, to]) => (
        <Link key={text} href={to} aria-current={current === value ? "true" : undefined} className="inline-flex min-h-11 items-center rounded-control border border-border px-2.5 text-small text-muted hover:text-text aria-[current=true]:border-text aria-[current=true]:bg-text aria-[current=true]:text-page sm:min-h-8">
          {text}
        </Link>
      ))}
    </nav>
  );
}

const one = (v: unknown) => (typeof v === "string" ? v : undefined);

async function Owned({ searchParams }: { searchParams: PageProps<"/videos">["searchParams"] }) {
  await requireOwner();
  const sp = await searchParams;
  const f = parseLibraryQuery(sp);
  let req = parsePage(sp);
  let { rows, total } = await listVideos(getPool(), f, req);
  const clamped = clampPage(req, total);
  if (clamped.page !== req.page) {
    req = clamped;
    ({ rows, total } = await listVideos(getPool(), f, req));
  }
  const rate = await loadInrRate(getPool());
  const filtered = Boolean(f.format || f.status || f.language || f.kind);
  const to = (over: Partial<Record<keyof LibraryFilter, string | undefined>>) => libraryHref(f, { ...over, page: undefined });
  const params = { format: f.format, status: f.status, language: f.language, kind: f.kind, page: one(sp.page), size: one(sp.size) };

  return (
    <div className="flex min-w-0 flex-col gap-layout">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-page-title font-semibold tracking-tight">Videos</h1>
          <p className="m-0 text-body text-muted">Every video you have started, newest first.</p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="secondary"><Link href="/videos/new?format=long">New long video</Link></Button>
          <Button asChild><Link href="/videos/new?format=short">New short</Link></Button>
        </div>
      </div>

      <section aria-label="Filters" className="flex min-w-0 flex-col gap-2 rounded-card border border-border bg-surface p-pad">
        <Chips label="Status" current={f.status} options={[["All", undefined, to({ status: undefined })], ...STATUSES.map((s): [string, string, string] => [STATUS_WORDS[s].label, s, to({ status: s })])]} />
        <Chips label="Format" current={f.format} options={[["All", undefined, to({ format: undefined })], ...FORMATS.map((s): [string, string, string] => [FORMAT_WORDS[s], s, to({ format: s })])]} />
        <Chips label="Language" current={f.language} options={[["All", undefined, to({ language: undefined })], ...LANGUAGE_ORDER.map((s): [string, string, string] => [LANGUAGE_WORDS[s], s, to({ language: s })])]} />
        <Chips label="Kind" current={f.kind} options={[["All", undefined, to({ kind: undefined })], ...KINDS.map((s): [string, string, string] => [KIND_WORDS[s], s, to({ kind: s })])]} />
      </section>

      {rows.length === 0 ? (
        <EmptyState
          icon={Film}
          title="No videos yet"
          body="Start your first short: pick a topic and a language."
          action={<Button asChild><Link href="/videos/new?format=short">New short</Link></Button>}
          filtered={filtered ? { clearHref: "/videos" } : undefined}
        />
      ) : (
        <>
          <DataTable>
            <caption className="sr-only">Videos, newest first</caption>
            <DataHead>
              <HeadCell>Title</HeadCell>
              <HeadCell>Status</HeadCell>
              <HeadCell className="max-md:hidden">Language</HeadCell>
              <HeadCell className="max-md:hidden">Format</HeadCell>
              <HeadCell className="max-lg:hidden">Type</HeadCell>
              <HeadCell className="text-right">Cost</HeadCell>
              <HeadCell className="max-sm:hidden">Last activity</HeadCell>
            </DataHead>
            <tbody data-testid="library-list">
              {rows.map((v) => {
                const st = STATUS_WORDS[v.status];
                return (
                  <DataRow key={v.id} href={`/videos/${v.id}`} className="[&>td]:align-middle" >
                    <Cell className="max-w-0 w-[40%]">
                      <span data-video={v.id} className="block truncate" title={v.topic}>
                        <RowLink href={`/videos/${v.id}`}>{v.topic}</RowLink>
                        <span className="sr-only">, {LANGUAGE_WORDS[v.language]}, {formatUsd(v.costMicroUsd, rate)} so far</span>
                      </span>
                    </Cell>
                    <Cell><Pill tone={st.tone}>{st.label}</Pill></Cell>
                    <Cell className="text-muted max-md:hidden">{LANGUAGE_WORDS[v.language]}</Cell>
                    <Cell className="text-muted max-md:hidden">{FORMAT_WORDS[v.format]}</Cell>
                    <Cell className="text-muted max-lg:hidden">{KIND_WORDS[v.kind]}</Cell>
                    <Cell className="text-right tabular-nums">{formatUsd(v.costMicroUsd, rate)}</Cell>
                    <Cell className="text-muted max-sm:hidden"><TimeAgo at={v.lastActivity} /></Cell>
                  </DataRow>
                );
              })}
            </tbody>
          </DataTable>
          <Pagination page={req.page} size={req.size} total={total} hrefFor={(c) => pageHref("/videos", params, c)} />
        </>
      )}
    </div>
  );
}
