import Link from "next/link";
import { CalendarDays, Clapperboard, House, SlidersHorizontal, Upload, type LucideIcon } from "lucide-react";
import { cn, fade, focusRing } from "../lib/cn";
import { Mark } from "./mark";
import { areaFor, visibleAreas, type Area } from "./nav-config";

export const AREA_ICONS: Record<Area, LucideIcon> = { Home: House, Make: Clapperboard, Plan: CalendarDays, Publish: Upload, Settings: SlidersHorizontal };

function RailItem({ area, href, current }: { area: Area; href: string; current: Area | null }) {
  const Icon = AREA_ICONS[area];
  const on = current === area;
  return (
    <Link
      href={href}
      aria-current={on ? "page" : undefined}
      className={cn(
        "flex w-16 flex-col items-center gap-1 rounded-card py-1.5 text-[11px] leading-none",
        on ? "bg-raised font-medium text-text" : "text-muted hover:text-text",
        fade,
        focusRing,
      )}
    >
      <Icon size={18} aria-hidden strokeWidth={1.75} />
      {area}
    </Link>
  );
}

/** Icon strip (spec §4.2, layout C): the five areas, icon + small label. `active` = current pathname, null while unknown. */
export function Rail({ active }: { active: string | null }) {
  const current = active === null ? null : areaFor(active);
  const areas = visibleAreas();
  const main = areas.filter((a) => a.area !== "Settings");
  const settings = areas.find((a) => a.area === "Settings");
  return (
    <nav aria-label="Areas" className="flex h-full flex-col items-center gap-1 py-3">
      <Link href="/" aria-label="YT Studio, home" className={cn("mb-3 flex size-8 items-center justify-center rounded-control text-text", focusRing)}>
        <Mark />
      </Link>
      {main.map((a) => (
        <RailItem key={a.area} area={a.area} href={a.href} current={current} />
      ))}
      <div className="flex-1" />
      {settings && <RailItem area="Settings" href={settings.href} current={current} />}
    </nav>
  );
}
