import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { cn, focusRing } from "../lib/cn";
import { NAV_ITEMS, areaFor, isActive, visibleAreas } from "./nav-config";

export type Crumb = { label: string; href?: string };

/** "Make / Videos" for /videos; the page crumb is a link when the path goes deeper (a video's own page). */
export function crumbs(pathname: string): Crumb[] {
  const area = areaFor(pathname);
  const item = NAV_ITEMS.find((i) => isActive(i.href, pathname) && i.area === area);
  if (area === "Home") return [{ label: item?.href === "/" || !item ? "Home" : item.label }];
  const areaHref = visibleAreas().find((a) => a.area === area)?.href;
  const out: Crumb[] = [{ label: area, href: areaHref }];
  if (item) out.push(pathname === item.href ? { label: item.label } : { label: item.label, href: item.href });
  return out;
}

export function Breadcrumbs({ active }: { active: string | null }) {
  if (active === null) return null;
  const list = crumbs(active);
  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex min-w-0 items-center gap-1.5 text-body text-muted">
        {list.map((c, i) => (
          <li key={i} className="flex min-w-0 items-center gap-1.5">
            {i > 0 && <ChevronRight size={14} aria-hidden className="shrink-0 text-faint" />}
            {c.href ? (
              <Link href={c.href} className={cn("truncate rounded-control hover:text-text", focusRing)}>
                {c.label}
              </Link>
            ) : (
              <span aria-current={i === list.length - 1 ? "page" : undefined} className="truncate font-medium text-text">
                {c.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
