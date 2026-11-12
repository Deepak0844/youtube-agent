import { Suspense } from "react";
import { BottomBar } from "@/ui/shell/bottom-bar";
import { AreaMenuWithCounts } from "@/ui/shell/area-menu-counts";
import { RailLive } from "@/ui/shell/nav-live";
import { Rail } from "@/ui/shell/rail";
import { SkipLink } from "@/ui/shell/skip-link";
import { TopBar } from "@/ui/shell/topbar";

// Frame (spec 2026-11-12 §2, layout C + D): icon strip and area menu on the grey ground, the page in a bordered framed
// panel with an 8 px inset. The window scrolls (so back/forward keep their place); strip and menu stay put.
// The shell is static: nothing here reads the session except the spend figure, which sits in its own <Suspense>.
// Each page still guards itself with requireOwner() (the layout is not a security boundary).
export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <>
      <SkipLink />
      <div className="flex min-h-dvh bg-ground">
        <div className="sticky top-0 hidden h-dvh w-20 shrink-0 md:block">
          <Suspense fallback={<Rail active={null} />}>
            <RailLive />
          </Suspense>
        </div>
        <Suspense fallback={null}>
          <AreaMenuWithCounts />
        </Suspense>
        <div className="flex min-w-0 flex-1 flex-col bg-page md:my-2 md:mr-2 md:rounded-frame md:border md:border-border">
          <TopBar />
          <main id="main" tabIndex={-1} className="flex-1 px-4 pt-6 pb-24 outline-none md:px-gutter md:pb-12">
            {children}
          </main>
        </div>
      </div>
      <BottomBar />
    </>
  );
}
