"use client";

import { usePathname } from "next/navigation";
import { SideNav } from "./sidebar";
import { BottomNav } from "./bottom-bar";

// The only place the shell reads the URL. usePathname may suspend on routes with unknown params (cacheComponents), so
// both callers wrap these in <Suspense> with the same list rendered without an active item.
export function SideNavLive() {
  return <SideNav active={usePathname()} />;
}

export function BottomNavLive() {
  return <BottomNav active={usePathname()} />;
}
