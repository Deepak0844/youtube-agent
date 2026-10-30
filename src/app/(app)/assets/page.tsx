import Link from "next/link";
import { Suspense } from "react";
import { z } from "zod";
import { requireOwner } from "@/lib/auth/require-owner";
import { toCards } from "@/server/db/asset-cards";
import { loadAssetDays } from "@/server/db/asset-settings";
import { listAssets, listTags } from "@/server/db/assets";
import { getPool } from "@/server/db/pool";
import { EmptyFrame } from "@/ui/domain/empty-frame";
import { Input } from "@/ui/primitives/input";
import { Skeleton } from "@/ui/primitives/skeleton";
import { AssetGrid } from "./asset-grid";
import { UploadZone } from "./upload-zone";

// requireOwner() and searchParams are request-time data, so they sit inside <Suspense> (cacheComponents). Filters are plain
// links and a GET search form: no client state, the address bar is the state.
export default function AssetsPage({ searchParams }: PageProps<"/assets">) {
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

const query = z.object({
  kind: z.enum(["image", "audio"]).optional().catch(undefined),
  source: z.enum(["upload", "generated", "stock", "found"]).optional().catch(undefined),
  tag: z.string().max(60).optional().catch(undefined),
  q: z.string().max(100).optional().catch(undefined),
  trash: z.literal("1").optional().catch(undefined),
});
type Q = z.infer<typeof query>;

const first = (v: unknown) => (Array.isArray(v) ? v[0] : v);
const href = (q: Q, over: Partial<Record<keyof Q, string | undefined>>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...q, ...over })) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `/assets?${s}` : "/assets";
};

const EMPTY = {
  image: "No images yet. Drop some photos here to use them in a video.",
  audio: "No sound files yet. Drop some audio here to use it in a video.",
  all: "Nothing here yet. Drop some photos or sound files here to use them in a video.",
};

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

async function Owned({ searchParams }: { searchParams: PageProps<"/assets">["searchParams"] }) {
  await requireOwner();
  const raw = await searchParams;
  const q = query.parse({ kind: first(raw.kind), source: first(raw.source), tag: first(raw.tag), q: first(raw.q), trash: first(raw.trash) });
  const db = getPool();
  const [assets, tags] = await Promise.all([listAssets(db, { kind: q.kind, source: q.source, tag: q.tag, q: q.q, trash: q.trash === "1" }), listTags(db)]);
  const [cards, { trashDays }] = await Promise.all([toCards(db, assets), loadAssetDays(db)]);

  return (
    <div className="flex min-w-0 flex-col gap-layout">
      <header>
        <h1 className="text-page-title font-semibold tracking-tight">Assets</h1>
        <p className="mt-2 max-w-prose text-body text-muted">
          Photos and sound files for your videos. Deleted files stay in the trash for {trashDays} days. Files marked Keep are never cleaned up automatically. Each upload shows the day it will be deleted; the clean-up job arrives with publishing, so nothing is deleted on that day yet.
        </p>
      </header>

      {q.trash ? null : <UploadZone />}

      <section aria-labelledby="files-h" className="flex min-w-0 flex-col gap-gap">
        <h2 id="files-h" className="sr-only">
          Files
        </h2>
        <form action="/assets" className="flex min-w-0 gap-2">
          {(["kind", "source", "tag", "trash"] as const).map((k) => (q[k] ? <input key={k} type="hidden" name={k} value={q[k]} /> : null))}
          <Input type="search" name="q" defaultValue={q.q} aria-label="Search by name" placeholder="Search by name" maxLength={100} className="sm:max-w-xs" />
        </form>
        <Chips label="Show" current={q.trash} options={[["Files", undefined, href(q, { trash: undefined })], ["Trash", "1", href(q, { trash: "1" })]]} />
        <Chips label="Type" current={q.kind} options={[["All", undefined, href(q, { kind: undefined })], ["Images", "image", href(q, { kind: "image" })], ["Sound", "audio", href(q, { kind: "audio" })]]} />
        <Chips
          label="From"
          current={q.source}
          options={[["Any", undefined, href(q, { source: undefined })], ...(["upload", "generated", "stock", "found"] as const).map((s): [string, string, string] => [s[0]!.toUpperCase() + s.slice(1), s, href(q, { source: s })])]}
        />
        {tags.length ? <Chips label="Tag" current={q.tag} options={[["Any", undefined, href(q, { tag: undefined })], ...tags.slice(0, 30).map((t): [string, string, string] => [t, t, href(q, { tag: t })])]} /> : null}

        {cards.length === 0 ? (
          <EmptyFrame message={q.trash ? "The trash is empty." : EMPTY[q.kind ?? "all"]} />
        ) : (
          <AssetGrid cards={cards} trash={q.trash === "1"} trashDays={trashDays} />
        )}
      </section>
    </div>
  );
}
