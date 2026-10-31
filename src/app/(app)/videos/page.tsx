import Link from "next/link";
import { Suspense } from "react";
import { requireOwner } from "@/lib/auth/require-owner";
import { FORMAT_WORDS, FORMATS, KIND_WORDS, KINDS, LANGUAGE_ORDER, LANGUAGE_WORDS, STATUSES, STATUS_WORDS, ageLabel, libraryHref, parseLibraryQuery, type LibraryFilter } from "@/server/core/videos-view";
import { getPool } from "@/server/db/pool";
import { listVideos } from "@/server/db/videos-list";
import { EmptyFrame } from "@/ui/domain/empty-frame";
import { formatUsd } from "@/ui/domain/spend-line";
import { Button } from "@/ui/primitives/button";
import { Pill } from "@/ui/primitives/pill";
import { Skeleton } from "@/ui/primitives/skeleton";

// The Library (Doc 4 /videos): every video, newest first. Filters and the page number live in the address bar.
export default function Library({ searchParams }: PageProps<"/videos">) {
  return (
    <Suspense
      fallback={
        <div aria-hidden className="flex min-w-0 flex-col gap-layout">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-96 w-full rounded-card" />
        </div>
      }
    >
      <Owned searchParams={searchParams} />
    </Suspense>
  );
}

function Chips({ label, current, options }: { label: string; current: string | undefined; options: Array<[string, string | undefined, string]> }) {
  return (
    <nav aria-label={label} className="flex min-w-0 flex-wrap items-center gap-2">
      <span className="text-small text-muted">{label}</span>
      {options.map(([text, value, to]) => (
        <Link key={text} href={to} aria-current={current === value ? "true" : undefined} className="inline-flex min-h-11 items-center rounded-control bg-raised px-3 text-small aria-[current=true]:bg-text aria-[current=true]:text-ground sm:min-h-9">
          {text}
        </Link>
      ))}
    </nav>
  );
}

async function Owned({ searchParams }: { searchParams: PageProps<"/videos">["searchParams"] }) {
  await requireOwner();
  const f = parseLibraryQuery(await searchParams);
  const { rows, hasNext } = await listVideos(getPool(), f);
  const filtered = Boolean(f.format || f.status || f.language || f.kind);
  const to = (over: Partial<Record<keyof LibraryFilter, string | undefined>>) => libraryHref(f, { ...over, page: undefined });
  const now = new Date();

  return (
    <div className="flex min-w-0 flex-col gap-layout">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-page-title font-semibold tracking-tight">Library</h1>
          <p className="m-0 text-body text-muted">Every video you have started, newest first.</p>
        </div>
        <Button asChild>
          <Link href="/videos/new">New short</Link>
        </Button>
      </div>

      <section aria-label="Filters" className="flex min-w-0 flex-col gap-2">
        <Chips label="Status" current={f.status} options={[["All", undefined, to({ status: undefined })], ...STATUSES.map((s): [string, string, string] => [STATUS_WORDS[s].label, s, to({ status: s })])]} />
        <Chips label="Format" current={f.format} options={[["All", undefined, to({ format: undefined })], ...FORMATS.map((s): [string, string, string] => [FORMAT_WORDS[s], s, to({ format: s })])]} />
        <Chips label="Language" current={f.language} options={[["All", undefined, to({ language: undefined })], ...LANGUAGE_ORDER.map((s): [string, string, string] => [LANGUAGE_WORDS[s], s, to({ language: s })])]} />
        <Chips label="Kind" current={f.kind} options={[["All", undefined, to({ kind: undefined })], ...KINDS.map((s): [string, string, string] => [KIND_WORDS[s], s, to({ kind: s })])]} />
      </section>

      {rows.length === 0 ? (
        <EmptyFrame
          message={filtered ? "No videos match these filters." : f.page > 1 ? "No more videos." : "No videos yet. Start your first short."}
          action={
            <Button asChild variant="secondary">
              <Link href={filtered || f.page > 1 ? "/videos" : "/videos/new"}>{filtered || f.page > 1 ? "Show all videos" : "New short"}</Link>
            </Button>
          }
        />
      ) : (
        <ul data-testid="library-list" className="m-0 flex min-w-0 list-none flex-col p-0">
          {rows.map((v) => {
            const s = STATUS_WORDS[v.status];
            return (
              <li key={v.id} data-video={v.id} className="border-b border-rule">
                <Link href={`/videos/${v.id}`} className="flex min-h-11 min-w-0 flex-col gap-1 rounded-control py-3 hover:bg-raised sm:flex-row sm:items-center sm:gap-4 sm:px-2">
                  <span className="min-w-0 flex-1 text-body font-medium [overflow-wrap:anywhere]">{v.topic}</span>
                  <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-small text-muted">
                    <Pill tone={s.tone}>{s.label}</Pill>
                    <span>{LANGUAGE_WORDS[v.language]}</span>
                    <span>{FORMAT_WORDS[v.format]}</span>
                    <span className="tabular-nums">{formatUsd(v.costMicroUsd)} so far</span>
                    <span>
                      <time dateTime={v.lastActivity.toISOString()}>{ageLabel(v.lastActivity, now)}</time>
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {f.page > 1 || hasNext ? (
        <nav aria-label="Pages" className="flex items-center justify-between gap-4">
          {f.page > 1 ? (
            <Link href={libraryHref(f, { page: f.page - 1 })} rel="prev" className="inline-flex min-h-11 items-center text-body underline sm:min-h-9">
              Newer
            </Link>
          ) : (
            <span />
          )}
          <span className="text-small text-muted">Page {f.page}</span>
          {hasNext ? (
            <Link href={libraryHref(f, { page: f.page + 1 })} rel="next" className="inline-flex min-h-11 items-center text-body underline sm:min-h-9">
              Older
            </Link>
          ) : (
            <span />
          )}
        </nav>
      ) : null}
    </div>
  );
}
