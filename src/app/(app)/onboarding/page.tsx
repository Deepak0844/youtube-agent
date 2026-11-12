import Link from "next/link";
import { Suspense } from "react";
import { requireOwner } from "@/lib/auth/require-owner";
import { dryRunChecks, onboardingSteps } from "@/server/core/onboarding";
import { loadOnboardingFacts } from "@/server/db/onboarding";
import { getPool } from "@/server/db/pool";
import { Button } from "@/ui/primitives/button";
import { Pill } from "@/ui/primitives/pill";

export const metadata = { title: "Get started" };

// First-run setup. Each step links to the page that already has the form; done/not-done is read from saved state.
// The wizard never sets a key or approves anything, and the last step only reads settings.
export default function OnboardingPage() {
  return (
    <Suspense fallback={<div aria-hidden className="h-96 rounded-card bg-surface" />}>
      <Owned />
    </Suspense>
  );
}

async function Owned() {
  await requireOwner();
  const facts = await loadOnboardingFacts(getPool());
  const steps = onboardingSteps(facts);
  const checks = dryRunChecks(facts);
  const doneCount = steps.filter((s) => s.done).length;
  return (
    <div className="flex min-w-0 flex-col gap-layout">
      <header>
        <h1 className="text-page-title font-semibold tracking-tight">Set up</h1>
        <p data-testid="progress" className="mt-2 max-w-prose text-body text-muted">{`${doneCount} of ${steps.length} steps done. Each step opens the page where you do it, then come back here.`}</p>
      </header>
      <ol className="m-0 flex list-none flex-col gap-3 p-0">
        {steps.map((s, i) => (
          <li key={s.id} id={s.id === "dryrun" ? "dryrun" : undefined} data-testid={`step-${s.id}`} className="flex min-w-0 flex-col gap-3 rounded-card bg-surface p-pad">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="m-0 text-title font-semibold">{`${i + 1}. ${s.title}`}</h2>
              <Pill tone={s.done ? "positive" : "neutral"}>{s.done ? "Done" : "Not done"}</Pill>
            </div>
            <p className="m-0 max-w-prose text-body text-muted">{s.text}</p>
            {s.id === "dryrun" ? (
              <ul aria-label="Readiness checks" className="m-0 flex list-none flex-col gap-1 p-0 text-body">
                {checks.map((c) => (
                  <li key={c.label}>{`${c.ok ? "Ready" : "Missing"}: ${c.label}`}</li>
                ))}
              </ul>
            ) : (
              <div><Button asChild variant={s.done ? "secondary" : "primary"}><Link href={s.href}>{s.cta}</Link></Button></div>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
