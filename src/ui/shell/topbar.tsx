import Link from "next/link";
import { Suspense } from "react";
import { Bell, Search } from "lucide-react";
import { requireOwner } from "@/lib/auth/require-owner";
import { getPool } from "@/server/db/pool";
import { getBudget } from "@/server/db/spend";
import { logoutAction } from "@/app/_actions/logout";
import { cn, focusRing } from "../lib/cn";
import { AccountMenu } from "./account-menu";
import { Mark } from "./mark";

const DEFAULT_DAY_CAP_USD = 15; // Doc 2 §4.5; used only until the budgets row is seeded
const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(2)}`;

// Real figure from `budgets` (scope "day"). Reads the session first (request-time data, so it sits inside <Suspense>).
async function SpendToday() {
  await requireOwner();
  let text: string;
  try {
    const b = await getBudget(getPool(), "day");
    const cap = b ? b.capMicroUsd : DEFAULT_DAY_CAP_USD * 1_000_000; // a missing row uses the default; null is "no limit"
    text = cap === null ? `${usd(b?.spentMicroUsd ?? 0)} today, no limit` : `${usd(b?.spentMicroUsd ?? 0)} of ${usd(cap)} today`;
  } catch {
    text = "Spend unavailable";
  }
  return <>{text}</>;
}

export function TopBar() {
  return (
    <header className="flex h-14 shrink-0 items-center gap-4 border-b border-border px-4 md:h-16 md:px-gutter">
      <Link href="/" aria-label="YT Studio, home" className={cn("flex items-center gap-2 rounded-control text-text md:hidden", focusRing)}>
        <Mark />
        <span className="text-section font-semibold tracking-tight">YT Studio</span>
      </Link>

      <form role="search" className="relative hidden w-full max-w-sm md:block">
        <Search size={14} aria-hidden className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" />
        <input
          type="search"
          role="searchbox"
          aria-label="Search"
          aria-describedby="search-note"
          disabled
          placeholder="Search"
          className="h-9 w-full rounded-control bg-surface pr-3 pl-9 text-body text-text placeholder:text-faint disabled:cursor-not-allowed"
        />
        <span id="search-note" className="sr-only">
          Search arrives in Phase 4
        </span>
      </form>

      <div className="ml-auto flex items-center gap-4 md:gap-5">
        <p className="text-small whitespace-nowrap text-muted md:text-body">
          <Suspense fallback="$– of $– today">
            <SpendToday />
          </Suspense>
        </p>
        <p className="hidden text-body whitespace-nowrap text-muted md:block">0 to review</p>
        <button
          type="button"
          disabled
          aria-label="Notifications, none"
          className="hidden size-9 items-center justify-center rounded-control text-faint md:flex"
        >
          <Bell size={18} aria-hidden />
        </button>
        <AccountMenu signOut={logoutAction} />
      </div>
    </header>
  );
}
