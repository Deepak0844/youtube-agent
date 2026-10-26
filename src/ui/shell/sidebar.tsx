import Link from "next/link";
import { Suspense } from "react";
import { cn, fade, focusRing } from "../lib/cn";
import { Mark } from "./mark";
import { SideNavLive } from "./nav-live";
import { isActive, visibleNav } from "./nav-config";

/** Presentational list: `active` is the current pathname, or null while it is not known (prerendered shell). */
export function SideNav({ active }: { active: string | null }) {
  return (
    <>
      {visibleNav().map(({ group, items }) => (
        <div key={group} className={group === "Home" ? "" : "mt-6"}>
          {group !== "Home" && <p className="mb-1 px-3 text-small text-faint">{group}</p>}
          <ul className="flex flex-col">
            {items.map((i) => {
              const on = active !== null && isActive(i.href, active);
              return (
                <li key={i.href}>
                  <Link
                    href={i.href}
                    aria-current={on ? "page" : undefined}
                    className={cn(
                      "flex h-[34px] items-center rounded-control px-3 text-body",
                      on ? "font-semibold text-text" : "font-normal text-muted hover:text-text",
                      fade,
                      focusRing,
                    )}
                  >
                    {i.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </>
  );
}

/** 210 px column, ruled on the right edge (Doc 3 §5). Hidden on phones, where the bottom bar takes over. */
export function Sidebar() {
  return (
    <aside className="sticky top-0 hidden h-dvh w-[var(--sidebar-width)] shrink-0 flex-col border-r border-border md:flex">
      <div className="flex h-16 items-center border-b border-border px-5">
        <Link href="/" aria-label="YT Studio, home" className={cn("flex items-center gap-3 rounded-control text-text", focusRing)}>
          <Mark />
          <span className="text-section font-semibold tracking-tight">YT Studio</span>
        </Link>
      </div>
      <nav aria-label="Primary" className="flex-1 overflow-y-auto px-2 py-5">
        <Suspense fallback={<SideNav active={null} />}>
          <SideNavLive />
        </Suspense>
      </nav>
    </aside>
  );
}
