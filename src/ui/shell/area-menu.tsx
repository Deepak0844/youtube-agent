import Link from "next/link";
import { cn, fade, focusRing } from "../lib/cn";
import { areaFor, isActive, visibleAreas, type Area, type NavItem } from "./nav-config";

function MenuLink({ item, active, count }: { item: NavItem; active: string | null; count?: number }) {
  const on = active !== null && isActive(item.href, active);
  return (
    <li>
      <Link
        href={item.href}
        aria-current={on ? "page" : undefined}
        className={cn(
          "flex min-h-11 items-center rounded-control px-2.5 text-body sm:min-h-8",
          on ? "bg-raised font-medium text-text" : "text-muted hover:bg-raised hover:text-text",
          fade,
          focusRing,
        )}
      >
        <span className="flex-1">{item.label}</span>
        {count ? (
          <span className="rounded-full bg-pill-warning-bg px-1.5 text-small font-medium tabular-nums text-pill-warning-ink">
            {count}
            <span className="sr-only"> waiting</span>
          </span>
        ) : null}
      </Link>
    </li>
  );
}

/** The links of one area (spec §4.2); `active` marks the current page. Settings shows its four named sections. */
export function AreaLinks({ area: name, active, counts }: { area: Area; active: string | null; counts?: Record<string, number> }) {
  const area = visibleAreas().find((a) => a.area === name);
  if (!area || area.area === "Home") return null;
  return area.sections ? (
    <div className="flex flex-col gap-4">
      {area.sections.map((s) => (
        <div key={s.section}>
          <p className="px-2.5 pb-1 text-small text-faint">{s.section}</p>
          <ul className="flex flex-col gap-0.5">
            {s.items.map((i) => (
              <MenuLink key={i.href} item={i} active={active} count={counts?.[i.href]} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  ) : (
    <ul className="flex flex-col gap-0.5">
      {area.items.map((i) => (
        <MenuLink key={i.href} item={i} active={active} count={counts?.[i.href]} />
      ))}
    </ul>
  );
}

/** Desktop area menu beside the icon strip (layout C). Hidden on Home and while the path is not known yet. */
export function AreaMenu({ active, counts }: { active: string | null; counts?: Record<string, number> }) {
  if (active === null || areaFor(active) === "Home") return null;
  return (
    <aside className="sticky top-0 hidden h-dvh w-[var(--sidebar-width)] shrink-0 overflow-y-auto px-2 py-4 md:block">
      <p className="px-2.5 pb-3 text-section font-semibold">{areaFor(active)}</p>
      <nav aria-label="Primary">
        <AreaLinks area={areaFor(active)} active={active} counts={counts} />
      </nav>
    </aside>
  );
}
