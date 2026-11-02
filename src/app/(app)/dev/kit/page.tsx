import { Suspense } from "react";
import { notFound } from "next/navigation";
import { requireOwner } from "@/lib/auth/require-owner";
import { LazyKitSamples } from "@/ui/kit/kit-lazy";

// Every scene kind on a small player, with sample data. Dev/staging only, never in the nav.
export default function DevKit() {
  return (
    <Suspense fallback={<div aria-hidden className="h-64 rounded-card bg-surface" />}>
      <Owned />
    </Suspense>
  );
}

async function Owned() {
  await requireOwner();
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <div data-testid="dev-ui" className="flex min-w-0 flex-col gap-layout">
      <h1 className="m-0 text-page-title font-semibold tracking-tight">Scene kit samples</h1>
      <LazyKitSamples />
    </div>
  );
}
