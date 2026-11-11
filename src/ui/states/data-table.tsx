import Link from "next/link";
import { ArrowDown, ArrowUp } from "lucide-react";
import type * as React from "react";
import { cn, focusRing } from "../lib/cn";

// Table pattern (spec §4.6.9): bordered card, sticky header band, one-line cells cut with "…" (full text on hover),
// sortable headers as links (sort lives in the URL), whole-row link.

export function DataTable({ className, children, ...p }: React.ComponentProps<"table">) {
  return (
    <div className="min-w-0 overflow-x-auto rounded-card border border-border bg-surface">
      <table className={cn("w-full border-collapse text-left text-body", className)} {...p}>
        {children}
      </table>
    </div>
  );
}

export function DataHead({ children }: { children: React.ReactNode }) {
  return (
    <thead className="sticky top-0 z-10 bg-raised text-small text-muted">
      <tr className="border-b border-border">{children}</tr>
    </thead>
  );
}

export function HeadCell({
  children,
  sortHref,
  sorted,
  className,
}: {
  children: React.ReactNode;
  sortHref?: string;
  sorted?: "asc" | "desc";
  className?: string;
}) {
  const sort = sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : undefined;
  return (
    <th scope="col" aria-sort={sort} className={cn("px-3 py-2 font-medium whitespace-nowrap", className)}>
      {sortHref ? (
        <Link href={sortHref} className={cn("inline-flex items-center gap-1 rounded-control hover:text-text", focusRing)}>
          {children}
          {sorted === "asc" && <ArrowUp size={12} aria-hidden />}
          {sorted === "desc" && <ArrowDown size={12} aria-hidden />}
        </Link>
      ) : (
        children
      )}
    </th>
  );
}

/** A row; with `href` the first link in it covers the whole row (keyboard: Tab reaches that link). */
export function DataRow({ children, href, className }: { children: React.ReactNode; href?: string; className?: string }) {
  return <tr className={cn("border-b border-border last:border-0", href && "relative hover:bg-raised", className)}>{children}</tr>;
}

export function Cell({ children, className }: { children?: React.ReactNode; className?: string }) {
  return <td className={cn("px-3 py-2.5 align-middle", className)}>{children}</td>;
}

/** Cell link that makes the whole row clickable. */
export function RowLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className={cn("font-medium text-text after:absolute after:inset-0 after:content-['']", focusRing)}>
      {children}
    </Link>
  );
}

/** One line, cut with "…"; the full text is on hover. */
export function TruncCell({ text, className }: { text: string; className?: string }) {
  return (
    <td className={cn("max-w-0 px-3 py-2.5 align-middle", className)}>
      <span title={text} className="block truncate">
        {text}
      </span>
    </td>
  );
}
