import Link from "next/link";
import { Suspense } from "react";
import { cn, fade, focusRing } from "../lib/cn";
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "../primitives/sheet";
import { BottomNavLive } from "./nav-live";
import { bottomBarItems, isActive } from "./nav-config";

const slot = "relative flex min-h-14 min-w-11 flex-1 items-center justify-center px-1 text-small whitespace-nowrap";
const topMark = <span aria-hidden className="absolute inset-x-3 top-0 h-0.5 rounded-control bg-text" />;

/** Phone navigation: at most 5 destinations, text labels only. Active = bright + bold + a bar on the top edge (shape, not colour alone). */
export function BottomNav({ active }: { active: string | null }) {
  const { main, more } = bottomBarItems();
  const moreActive = active !== null && more.some((i) => isActive(i.href, active));
  return (
    <ul className="flex">
      {main.map((i) => {
        const on = active !== null && isActive(i.href, active);
        return (
          <li key={i.href} className="flex flex-1">
            <Link href={i.href} aria-current={on ? "page" : undefined} className={cn(slot, on ? "font-semibold text-text" : "text-muted", fade, focusRing)}>
              {on && topMark}
              {i.label}
            </Link>
          </li>
        );
      })}
      {more.length > 0 && (
        <li className="flex flex-1">
          <Sheet>
            <SheetTrigger className={cn(slot, moreActive ? "font-semibold text-text" : "text-muted", fade, focusRing)}>
              {moreActive && topMark}
              More
            </SheetTrigger>
            <SheetContent side="bottom">
              <SheetTitle>More</SheetTitle>
              <SheetDescription className="sr-only">Other places in the studio</SheetDescription>
              <ul className="flex flex-col">
                {more.map((i) => (
                  <li key={i.href}>
                    <Link
                      href={i.href}
                      aria-current={active !== null && isActive(i.href, active) ? "page" : undefined}
                      className={cn("flex min-h-11 items-center rounded-control px-3 text-body text-muted hover:text-text aria-[current=page]:font-semibold aria-[current=page]:text-text", fade, focusRing)}
                    >
                      {i.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </SheetContent>
          </Sheet>
        </li>
      )}
    </ul>
  );
}

export function BottomBar() {
  return (
    <nav aria-label="Bottom" className="fixed inset-x-0 bottom-0 z-40 bg-surface pb-[env(safe-area-inset-bottom)] md:hidden">
      <Suspense fallback={<BottomNav active={null} />}>
        <BottomNavLive />
      </Suspense>
    </nav>
  );
}
