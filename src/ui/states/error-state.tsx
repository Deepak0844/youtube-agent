"use client";

import { TriangleAlert } from "lucide-react";
import { Button } from "../primitives/button";

/** A part of a page that failed to load (spec §4.6.5): plain words and "Try again". Never takes the whole page down. */
export function ErrorState({ title = "This part could not load", body, retry }: { title?: string; body?: string; retry?: () => void }) {
  return (
    <div role="alert" className="flex min-w-0 flex-col items-center justify-center gap-3 rounded-card border border-border bg-surface px-6 py-12 text-center">
      <TriangleAlert aria-hidden size={20} className="text-negative" />
      <h2 className="text-section font-semibold">{title}</h2>
      <p className="max-w-[48ch] text-body text-muted">{body ?? "Nothing was changed. Try again, or come back in a minute."}</p>
      {retry && (
        <Button variant="secondary" onClick={retry}>
          Try again
        </Button>
      )}
    </div>
  );
}
