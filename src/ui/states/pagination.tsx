import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type * as React from "react";
import { PAGE_SIZES, pageLabel, pageLinks } from "@/server/core/paging";
import { cn, fade, focusRing } from "../lib/cn";

const cell = cn("inline-flex h-8 min-w-8 items-center justify-center rounded-control px-2 text-body", fade, focusRing);

function Step({ to, pages, hrefFor, label, children }: { to: number; pages: number; hrefFor: (c: { page?: number }) => string; label: string; children: React.ReactNode }) {
  return to < 1 || to > pages ? (
    <span aria-disabled="true" aria-label={label} role="link" className={cn(cell, "text-faint opacity-50")}>
      {children}
    </span>
  ) : (
    <Link href={hrefFor({ page: to })} aria-label={label} className={cn(cell, "text-muted hover:bg-raised hover:text-text")}>
      {children}
    </Link>
  );
}

/** "1–25 of 312", previous / numbered pages / next, and rows per page. Plain links: works without JavaScript. */
export function Pagination({
  page,
  size,
  total,
  hrefFor,
}: {
  page: number;
  size: number;
  total: number;
  hrefFor: (change: { page?: number; size?: number }) => string;
}) {
  const pages = Math.max(1, Math.ceil(total / size));
  return (
    <nav aria-label="Pages" className="flex min-w-0 flex-wrap items-center justify-between gap-3 text-small text-muted">
      <p>{pageLabel(page, size, total)}</p>
      <div className="flex items-center gap-1">
        <Step to={page - 1} pages={pages} hrefFor={hrefFor} label="Previous page">
          <ChevronLeft size={14} aria-hidden />
        </Step>
        {pageLinks(page, pages).map((n, i) =>
          n === "…" ? (
            <span key={`gap${i}`} aria-hidden className="px-1">
              …
            </span>
          ) : (
            <Link
              key={n}
              href={hrefFor({ page: n })}
              aria-current={n === page ? "page" : undefined}
              className={cn(cell, n === page ? "border border-border bg-surface text-text" : "text-muted hover:bg-raised hover:text-text")}
            >
              {n}
            </Link>
          ),
        )}
        <Step to={page + 1} pages={pages} hrefFor={hrefFor} label="Next page">
          <ChevronRight size={14} aria-hidden />
        </Step>
      </div>
      <p className="flex items-center gap-1">
        <span>Rows</span>
        {PAGE_SIZES.map((s) => (
          <Link key={s} href={hrefFor({ size: s, page: 1 })} aria-current={s === size ? "true" : undefined} className={cn(cell, s === size ? "text-text underline underline-offset-4" : "")}>
            {s}
          </Link>
        ))}
      </p>
    </nav>
  );
}
