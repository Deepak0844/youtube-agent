import { Suspense } from "react";
import { requireOwner } from "@/lib/auth/require-owner";

// Home with honest zeros: nothing is in production yet, so the screen says so in the words of the trade.
// requireOwner() reads the cookie (request-time data), so it runs inside <Suspense>.
export default function Home() {
  return (
    <Suspense fallback={<div aria-hidden className="h-64 rounded-card bg-surface" />}>
      <Owned />
    </Suspense>
  );
}

async function Owned() {
  await requireOwner();
  return <HomeFrame />;
}

const figure = "text-kpi font-semibold tabular-nums";

function HomeFrame() {
  return (
    <div className="grid gap-layout xl:grid-cols-[1fr_384px]">
      <div className="flex min-w-0 flex-col gap-layout">
        <h1 className="text-page-title font-semibold tracking-tight">Home</h1>

        <section aria-labelledby="waiting-h" className="flex flex-col gap-gap">
          <div className="grid grid-cols-3 items-end gap-x-4 sm:flex sm:gap-x-10">
            <p>
              <span data-testid="waiting-count" className="block text-[36px] leading-none font-semibold tabular-nums">0</span>
              <span id="waiting-h" className="mt-2 block text-body text-muted">Waiting on you</span>
            </p>
            <p>
              <span className={`${figure} block leading-none`}>0</span>
              <span className="mt-2 block text-body text-muted">In production</span>
            </p>
            <p>
              <span className={`${figure} block leading-none`}>0</span>
              <span className="mt-2 block text-body text-muted">Published this month</span>
            </p>
          </div>

          <div className="rounded-card bg-surface p-pad">
            <h2 className="text-title font-semibold">Decision queue</h2>
            <p className="mt-gap text-body text-muted">Nothing is waiting for your decision.</p>
            <p className="mt-1 text-small text-faint">Scripts, costs and videos that need your say-so will line up here, oldest first.</p>
          </div>
        </section>
      </div>

      <aside aria-label="Recent activity" className="flex flex-col gap-layout">
        <div className="rounded-card bg-surface p-pad">
          <h2 className="text-section font-semibold">Recent uploads</h2>
          <p className="mt-gap text-body text-muted">No uploads yet.</p>
        </div>
      </aside>
    </div>
  );
}
