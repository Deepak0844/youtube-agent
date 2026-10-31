import { isEnabled } from "@/lib/flags";

// Doc 4 §1. The full list lives here; only items whose flag is on are shown (see src/lib/flags.ts).
export type NavGroup = "Home" | "Make" | "Plan" | "Publish" | "Settings";
export interface NavItem {
  label: string;
  href: string;
  group: NavGroup;
  phase: number;
  flag: string;
}

const item = (group: NavGroup, label: string, href: string, phase: number, flag: string): NavItem => ({ label, href, group, phase, flag });

export const NAV_ITEMS: readonly NavItem[] = [
  item("Home", "Home", "/", 1, "home"),
  item("Make", "Queue", "/queue", 2, "queue"),
  item("Make", "Library", "/videos", 2, "library"),
  item("Make", "New", "/videos/new", 2, "new"),
  item("Make", "Assets", "/assets", 4, "assets"),
  item("Make", "Ideas", "/ideas", 6, "ideas"),
  item("Make", "Series", "/series", 6, "series"),
  item("Plan", "Calendar", "/calendar", 6, "plan.calendar"),
  item("Plan", "Research", "/research", 6, "plan.research"),
  item("Plan", "Targets", "/targets", 6, "plan.targets"),
  item("Publish", "Uploads", "/uploads", 5, "publish.uploads"),
  item("Publish", "Engagement", "/engagement", 5, "publish.engagement"),
  item("Publish", "Analytics", "/analytics", 5, "publish.analytics"),
  item("Settings", "Account", "/settings/account", 1, "settings.account"),
  item("Settings", "Models", "/settings/models", 1, "settings.models"),
  item("Settings", "Providers", "/settings/providers", 3, "settings.providers"),
  item("Settings", "Keys", "/settings/keys", 1, "settings.keys"),
  item("Settings", "Google app", "/settings/google", 1, "settings.google"),
  item("Settings", "API tokens", "/settings/tokens", 5, "settings.tokens"),
  item("Settings", "Channels", "/settings/channels", 5, "settings.channels"),
  item("Settings", "Budgets", "/settings/budgets", 3, "settings.budgets"),
  item("Settings", "Assets", "/settings/assets", 4, "settings.assets"),
  item("Settings", "Policies", "/settings/policies", 3, "settings.policies"),
  item("Settings", "Notifications", "/settings/notifications", 7, "settings.notifications"),
  item("Settings", "Schedule", "/settings/schedule", 6, "settings.schedule"),
  item("Settings", "Audit", "/settings/audit", 1, "settings.audit"),
  item("Settings", "Jobs & health", "/settings/health", 7, "settings.health"),
  item("Settings", "System", "/settings/system", 1, "settings.system"),
];

export interface VisibleGroup {
  group: NavGroup;
  items: NavItem[];
}

/** Enabled items only, grouped in Doc 4 order; empty groups are dropped. */
export function visibleNav(): VisibleGroup[] {
  const out: VisibleGroup[] = [];
  for (const i of NAV_ITEMS) {
    if (!isEnabled(i.flag)) continue;
    const g = out.find((x) => x.group === i.group);
    if (g) g.items.push(i);
    else out.push({ group: i.group, items: [i] });
  }
  return out;
}

const BOTTOM_SLOTS = 5;

/** Phone bottom bar: at most 5 destinations. Past 5, the first 4 plus "More" holding the rest. */
export function bottomBarItems(): { main: NavItem[]; more: NavItem[] } {
  const all = visibleNav().flatMap((g) => g.items);
  return all.length <= BOTTOM_SLOTS ? { main: all, more: [] } : { main: all.slice(0, BOTTOM_SLOTS - 1), more: all.slice(BOTTOM_SLOTS - 1) };
}

/** Home matches only "/"; every other item matches its own path and anything beneath it. */
export function isActive(href: string, pathname: string): boolean {
  if (href === "/") return pathname === "/";
  // A longer item that also matches wins: /videos/new lights New, not Library.
  if (NAV_ITEMS.some((i) => i.href.length > href.length && i.href.startsWith(href + "/") && (pathname === i.href || pathname.startsWith(i.href + "/")))) return false;
  return pathname === href || pathname.startsWith(href + "/");
}
