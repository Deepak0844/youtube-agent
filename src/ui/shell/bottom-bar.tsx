import Link from "next/link";
import { Suspense } from "react";
import { cn, fade, focusRing } from "../lib/cn";
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "../primitives/sheet";
import { AreaLinks } from "./area-menu";
import { BottomNavLive } from "./nav-live";
import { areaFor, bottomBarItems } from "./nav-config";
import { AREA_ICONS } from "./rail";

const slot = "relative flex min-h-14 min-w-11 flex-1 flex-col items-center justify-center gap-0.5 px-1 text-[11px] whitespace-nowrap";
const topMark = <span aria-hidden className="absolute inset-x-3 top-0 h-0.5 rounded-control bg-text" />;

/** Phone navigation (spec §4.4): the five areas. Home is a link; the others open their menu in a bottom sheet. */
export function BottomNav({ active }: { active: string | null }) {
  const current = active === null ? null : areaFor(active);
  return (
    <ul className="flex">
      {bottomBarItems().map(({ area, href }) => {
        const Icon = AREA_ICONS[area];
        const on = current === area;
        const look = cn(slot, on ? "font-semibold text-text" : "text-muted", fade, focusRing);
        return (
          <li key={area} className="flex flex-1">
            {area === "Home" ? (
              <Link href={href} aria-current={on ? "page" : undefined} className={look}>
                {on && topMark}
                <Icon size={18} aria-hidden />
                {area}
              </Link>
            ) : (
              <Sheet>
                <SheetTrigger aria-current={on ? "page" : undefined} className={look}>
                  {on && topMark}
                  <Icon size={18} aria-hidden />
                  {area}
                </SheetTrigger>
                <SheetContent side="bottom">
                  <SheetTitle>{area}</SheetTitle>
                  <SheetDescription className="sr-only">Pages in {area}</SheetDescription>
                  <nav aria-label={`${area} pages`}>
                    <AreaLinks area={area} active={active} />
                  </nav>
                </SheetContent>
              </Sheet>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function BottomBar() {
  return (
    <nav aria-label="Bottom" className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-page pb-[env(safe-area-inset-bottom)] md:hidden">
      <Suspense fallback={<BottomNav active={null} />}>
        <BottomNavLive />
      </Suspense>
    </nav>
  );
}
