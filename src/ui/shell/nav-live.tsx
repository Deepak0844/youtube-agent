"use client";

import { usePathname } from "next/navigation";
import { AreaMenu } from "./area-menu";
import { BottomNav } from "./bottom-bar";
import { Breadcrumbs } from "./breadcrumbs";
import { Rail } from "./rail";

// The only place the shell reads the URL. usePathname may suspend on routes with unknown params (cacheComponents), so
// callers wrap these in <Suspense> with the same part rendered without an active path.
export function RailLive() {
  return <Rail active={usePathname()} />;
}
export function AreaMenuLive() {
  return <AreaMenu active={usePathname()} />;
}
export function BreadcrumbsLive() {
  return <Breadcrumbs active={usePathname()} />;
}
export function BottomNavLive() {
  return <BottomNav active={usePathname()} />;
}
