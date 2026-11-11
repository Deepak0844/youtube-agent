import { isEnabled } from "@/lib/flags";

// UI redesign spec 2026-11-12 §4.2: five areas, each with its own short menu; Settings in four named sections. The full
// list lives here; only items whose flag is on are shown (see src/lib/flags.ts). URLs never change.
export const AREAS = ["Home", "Make", "Plan", "Publish", "Settings"] as const;
export type Area = (typeof AREAS)[number];
export const SETTINGS_SECTIONS = ["You", "AI and media", "Money and safety", "System"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export interface NavItem {
  label: string;
  href: string;
  area: Area;
  section?: SettingsSection;
  phase: number;
  flag: string;
}

const item = (area: Exclude<Area, "Settings">, label: string, href: string, phase: number, flag: string): NavItem => ({ label, href, area, phase, flag });
const setting = (section: SettingsSection, label: string, href: string, phase: number, flag: string): NavItem => ({ label, href, area: "Settings", section, phase, flag });

export const NAV_ITEMS: readonly NavItem[] = [
  item("Home", "Home", "/", 1, "home"),
  item("Make", "Queue", "/queue", 2, "queue"),
  item("Make", "Videos", "/videos", 2, "library"),
  item("Make", "New video", "/videos/new", 2, "new"),
  item("Make", "Ideas", "/ideas", 6, "ideas"),
  item("Make", "Series", "/series", 6, "series"),
  item("Make", "Assets", "/assets", 4, "assets"),
  item("Plan", "Calendar", "/calendar", 6, "plan.calendar"),
  item("Plan", "Research", "/research", 6, "plan.research"),
  item("Plan", "Targets", "/targets", 6, "plan.targets"),
  item("Publish", "Uploads", "/uploads", 5, "publish.uploads"),
  item("Publish", "Engagement", "/engagement", 5, "publish.engagement"),
  item("Publish", "Analytics", "/analytics", 5, "publish.analytics"),
  setting("You", "Account", "/settings/account", 1, "settings.account"),
  setting("You", "Channels", "/settings/channels", 5, "settings.channels"),
  setting("You", "Google app", "/settings/google", 1, "settings.google"),
  setting("You", "Notifications", "/settings/notifications", 7, "settings.notifications"),
  setting("AI and media", "Models", "/settings/models", 1, "settings.models"),
  setting("AI and media", "Providers", "/settings/providers", 3, "settings.providers"),
  setting("AI and media", "Keys", "/settings/keys", 1, "settings.keys"),
  setting("AI and media", "Assets", "/settings/assets", 4, "settings.assets"),
  setting("Money and safety", "Budgets", "/settings/budgets", 3, "settings.budgets"),
  setting("Money and safety", "Policies", "/settings/policies", 3, "settings.policies"),
  setting("Money and safety", "Schedule", "/settings/schedule", 6, "settings.schedule"),
  setting("System", "Jobs & health", "/settings/health", 7, "settings.health"),
  setting("System", "System", "/settings/system", 1, "settings.system"),
  setting("System", "Audit log", "/settings/audit", 1, "settings.audit"),
  setting("System", "API tokens", "/settings/tokens", 5, "settings.tokens"),
];

export interface VisibleArea {
  area: Area;
  /** The area's first enabled page. */
  href: string;
  items: NavItem[];
  /** Settings only: the items in their named sections. */
  sections?: Array<{ section: SettingsSection; items: NavItem[] }>;
}

/** Enabled items only, in spec order; an area with no enabled page is left out. */
export function visibleAreas(): VisibleArea[] {
  const out: VisibleArea[] = [];
  for (const area of AREAS) {
    const items = NAV_ITEMS.filter((i) => i.area === area && isEnabled(i.flag));
    if (!items.length) continue;
    const v: VisibleArea = { area, href: items[0]!.href, items };
    if (area === "Settings") v.sections = SETTINGS_SECTIONS.map((section) => ({ section, items: items.filter((i) => i.section === section) })).filter((x) => x.items.length);
    out.push(v);
  }
  return out;
}

/** The area a path belongs to (pages outside the menu, like onboarding, count as Home). */
export function areaFor(pathname: string): Area {
  if (pathname.startsWith("/settings")) return "Settings";
  const hit = NAV_ITEMS.find((i) => i.href !== "/" && (pathname === i.href || pathname.startsWith(i.href + "/")));
  return hit?.area ?? "Home";
}

/** Phone bottom bar: the five areas. */
export function bottomBarItems(): Array<{ area: Area; href: string }> {
  return visibleAreas().map(({ area, href }) => ({ area, href }));
}

/** Home matches only "/"; every other item matches its own path and anything beneath it. */
export function isActive(href: string, pathname: string): boolean {
  if (href === "/") return pathname === "/";
  // A longer item that also matches wins: /videos/new lights New, not Library.
  if (NAV_ITEMS.some((i) => i.href.length > href.length && i.href.startsWith(href + "/") && (pathname === i.href || pathname.startsWith(i.href + "/")))) return false;
  return pathname === href || pathname.startsWith(href + "/");
}
