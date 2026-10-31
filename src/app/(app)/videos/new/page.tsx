import { Suspense } from "react";
import { requireOwner } from "@/lib/auth/require-owner";
import { Skeleton } from "@/ui/primitives/skeleton";
import { NewForm } from "./new-form";

export default function NewVideo() {
  return (
    <Suspense fallback={<Skeleton aria-hidden className="h-96 w-full rounded-card" />}>
      <Owned />
    </Suspense>
  );
}

async function Owned() {
  await requireOwner();
  return (
    <div className="flex min-w-0 flex-col gap-layout">
      <header className="flex flex-col gap-1">
        <h1 className="text-page-title font-semibold tracking-tight">New short</h1>
        <p className="m-0 max-w-prose text-body text-muted">Say what the video is about. The studio writes a script and stops to ask you before it spends money or publishes anything.</p>
      </header>
      <NewForm />
    </div>
  );
}
