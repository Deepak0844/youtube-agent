import { Suspense } from "react";
import { requireOwner } from "@/lib/auth/require-owner";
import { connectedChannelOptions } from "@/server/db/ideas";
import { getPool } from "@/server/db/pool";
import { NewSeriesForm } from "./new-series-form";

export const metadata = { title: "New series" };

export default function NewSeriesPage() {
  return (
    <Suspense fallback={<div aria-hidden className="h-96 rounded-card bg-surface" />}>
      <Owned />
    </Suspense>
  );
}

async function Owned() {
  await requireOwner();
  const channels = await connectedChannelOptions(getPool());
  return (
    <div className="flex min-w-0 flex-col gap-layout">
      <header>
        <h1 className="text-page-title font-semibold tracking-tight">New series</h1>
        <p className="mt-2 max-w-prose text-body text-muted">A series shares one channel, language and look across its parts. You add the episode list on the next page.</p>
      </header>
      <NewSeriesForm channels={channels} />
    </div>
  );
}
