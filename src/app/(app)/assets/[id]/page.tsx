import Link from "next/link";
import { Suspense } from "react";
import { z } from "zod";
import { requireOwner } from "@/lib/auth/require-owner";
import { toCards } from "@/server/db/asset-cards";
import { getAsset } from "@/server/db/assets";
import { getPool } from "@/server/db/pool";
import { Skeleton } from "@/ui/primitives/skeleton";
import { KeepSwitch } from "../keep-switch";

export default function AssetPage({ params }: PageProps<"/assets/[id]">) {
  return (
    <Suspense fallback={<Skeleton aria-hidden className="h-96 w-full rounded-card" />}>
      <Owned params={params} />
    </Suspense>
  );
}

async function Owned({ params }: { params: PageProps<"/assets/[id]">["params"] }) {
  await requireOwner();
  const id = z.uuid().safeParse((await params).id);
  const asset = id.success ? await getAsset(getPool(), id.data) : null;
  // Deliberately a page with its own <h1>, not notFound(): the session-required spec needs a heading on every page to prove denied responses carry no content.
  if (!asset)
    return (
      <div className="flex min-w-0 flex-col gap-2">
        <h1 className="text-page-title font-semibold tracking-tight">File not found</h1>
        <Link href="/assets" className="text-small text-muted underline">
          All assets
        </Link>
      </div>
    );
  const [card] = await toCards(getPool(), [asset]);
  const derived = Object.keys(asset.derivedRefs);

  return (
    <div className="flex min-w-0 flex-col gap-layout">
      <header>
        <Link href="/assets" className="text-small text-muted underline">
          All assets
        </Link>
        <h1 className="mt-2 text-page-title font-semibold tracking-tight [overflow-wrap:anywhere]">{asset.originalName}</h1>
        <p className="mt-1 text-small text-muted">
          {asset.kind === "image" ? "Image" : "Sound"} · {asset.source} · {(asset.bytes / 1024).toFixed(0)} KB
          {asset.width && asset.height ? ` · ${asset.width}×${asset.height}` : ""}
          {asset.durationS !== null ? ` · ${asset.durationS.toFixed(1)} s` : ""}
        </p>
        {asset.deletedAt ? <p className="mt-1 text-small text-pill-warning-ink">In the trash until {asset.purgeAt?.toISOString().slice(0, 10)}.</p> : null}
      </header>

      {card?.url ? (
        <section aria-label="Preview" className="max-w-xl">
          {asset.kind === "image" ? (
            // eslint-disable-next-line @next/next/no-img-element -- a signed media URL
            <img src={card.url} alt={asset.caption ?? ""} className="max-h-96 rounded-card" />
          ) : (
            <audio controls src={card.url} className="w-full" />
          )}
        </section>
      ) : null}

      <section aria-labelledby="keep-h" className="rounded-card bg-surface p-pad">
        <h2 id="keep-h" className="text-title font-semibold">
          Keep
        </h2>
        <KeepSwitch id={asset.id} keep={asset.keep} />
      </section>

      <section aria-labelledby="use-h" className="rounded-card bg-surface p-pad">
        <h2 id="use-h" className="text-title font-semibold">
          Used in
        </h2>
        <p className="mt-2 text-body text-muted">Which videos use this file is not tracked yet.</p>
      </section>

      <section aria-labelledby="rights-h" className="rounded-card bg-surface p-pad">
        <h2 id="rights-h" className="text-title font-semibold">
          Rights
        </h2>
        <ul className="mt-2 flex flex-col gap-2">
          {asset.rights.attestations.map((a, i) => (
            <li key={i} className="text-body">
              <time dateTime={a.at}>{a.at.slice(0, 19).replace("T", " ")} UTC</time>: {a.text}
              {a.consent_likeness ? ", the person agreed to be shown" : ""}
              {a.consent_voice ? ", the speaker agreed" : ""}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="versions-h" className="rounded-card bg-surface p-pad">
        <h2 id="versions-h" className="text-title font-semibold">
          Other versions
        </h2>
        <p className="mt-2 text-body text-muted">{derived.length ? derived.join(", ") : "None made yet."}</p>
      </section>

      {asset.tags.length ? <p className="text-small text-muted">Tags: {asset.tags.join(", ")}</p> : null}
    </div>
  );
}
