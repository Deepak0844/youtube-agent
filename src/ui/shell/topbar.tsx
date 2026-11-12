import Link from "next/link";
import { Suspense } from "react";
import { Bell } from "lucide-react";
import { requireOwner } from "@/lib/auth/require-owner";
import { getPool } from "@/server/db/pool";
import { loadInrRate } from "@/server/db/system-settings";
import { formatMoney } from "@/server/core/display-format";
import { getBudget } from "@/server/db/spend";
import { logoutAction } from "@/app/_actions/logout";
import { cn, focusRing } from "../lib/cn";
import { AccountMenu } from "./account-menu";
import { CommandMenu } from "./command-menu";
import { NotificationBell } from "./bell";
import { Mark } from "./mark";
import { BreadcrumbsLive } from "./nav-live";

const DEFAULT_DAY_CAP_USD = 15; // Doc 2 §4.5; used only until the budgets row is seeded

/** The top-bar sentence. A missing row uses the default cap; a null cap is "no limit" (never $0). */
export function spendTodayText(b: { spentMicroUsd: number; capMicroUsd: number | null } | null, rate: number | null = null): string {
  const usd = (micro: number) => formatMoney(micro, rate);
  const cap = b ? b.capMicroUsd : DEFAULT_DAY_CAP_USD * 1_000_000;
  const spent = usd(b?.spentMicroUsd ?? 0);
  return cap === null ? `${spent} today, no limit` : `${spent} of ${usd(cap)} today`;
}

// Real figure from `budgets` (scope "day"). Reads the session first (request-time data, so it sits inside <Suspense>).
async function SpendToday() {
  await requireOwner();
  let phone: string;
  let wide: string;
  try {
    const b = await getBudget(getPool(), "day");
    phone = spendTodayText(b);
    wide = spendTodayText(b, await loadInrRate(getPool()));
  } catch {
    phone = wide = "Spend unavailable";
  }
  // Phone and tablet: dollars only (the rupee text does not fit). lg and up: dollars and rupees.
  return (
    <>
      <span className="lg:hidden">{phone}</span>
      <span className="hidden lg:inline">{wide}</span>
    </>
  );
}

export function TopBar() {
  return (
    <header className="flex h-14 shrink-0 items-center gap-4 border-b border-border px-4 md:h-12 md:px-gutter">
      <Link href="/" aria-label="YT Studio, home" className={cn("flex items-center gap-2 rounded-control text-text md:hidden", focusRing)}>
        <Mark />
        <span className="text-section font-semibold tracking-tight">YT Studio</span>
      </Link>

      <div className="hidden min-w-0 md:block">
        <Suspense fallback={null}>
          <BreadcrumbsLive />
        </Suspense>
      </div>

      <div className="ml-auto hidden lg:block">
        <CommandMenu />
      </div>
      <div className="flex items-center gap-4 max-lg:ml-auto md:gap-5">
        <p className="text-small whitespace-nowrap text-muted md:text-body">
          <Suspense fallback="$– of $– today">
            <SpendToday />
          </Suspense>
        </p>
        <Suspense fallback={<Bell size={18} aria-hidden className="text-faint" />}>
          <NotificationBell />
        </Suspense>
        <AccountMenu signOut={logoutAction} />
      </div>
    </header>
  );
}
