import Link from "next/link";
import { Suspense } from "react";
import { requireOwner } from "@/lib/auth/require-owner";
import { publicRequirements, publicSummary } from "@/server/core/policies-view";
import { getPool } from "@/server/db/pool";
import { loadPolicies } from "@/server/db/system-settings";
import { PUBLIC_PHRASE } from "@/server/core/channel-safety";
import { PublicSwitchForm } from "./public-form";
import { Pill } from "@/ui/primitives/pill";

// Shows the publishing policy. One switch can be changed here: public publishing (typed phrase to turn on, owner session only, audited).
// The evidence rule is not writable from any page: the settings guard tests pin that.
export default function PoliciesPage() {
  return (
    <Suspense fallback={<div aria-hidden className="h-96 rounded-card bg-surface" />}>
      <Owned />
    </Suspense>
  );
}

async function Owned() {
  await requireOwner();
  const p = await loadPolicies(getPool());
  return (
    <div className="flex flex-col gap-layout">
      <header className="flex flex-col gap-1">
        <h1 className="text-page-title font-semibold tracking-tight">Policies</h1>
        <p data-testid="public-summary" className="max-w-[68ch] text-body text-muted">{publicSummary(p)} Every publish still needs your approval, whatever is set here.</p>
        <p className="max-w-[68ch] text-small text-muted">The evidence rule is shown only; it is not changed from a page. The public switch below can be changed, and turning it on asks you to type a phrase.</p>
      </header>

      <section aria-labelledby="rules-h" className="rounded-card bg-surface p-pad">
        <h2 id="rules-h" className="mb-3 text-title font-semibold">Publishing rules</h2>
        <ul className="divide-y divide-rule">
          <li className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div className="max-w-[60ch]">
              <p className="text-body font-medium">Evidence is required</p>
              <p className="text-small text-muted">A video cannot be approved for publishing until its claims are checked on the Evidence tab.</p>
            </div>
            <Pill tone={p.requireEvidence ? "positive" : "warning"} data-testid="policy-evidence">{p.requireEvidence ? "Required" : "Not required"}</Pill>
          </li>
          <li className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div className="max-w-[60ch]">
              <p className="text-body font-medium">Public publishing</p>
              <p className="text-small text-muted">Off by default: videos upload as private or unlisted. Turning it on would not publish anything by itself; a video you approve could then be made public, on a channel that also allows it.</p>
            </div>
            <Pill tone={p.allowPublic ? "warning" : "positive"} data-testid="policy-public">{p.allowPublic ? "Allowed" : "Not allowed"}</Pill>
          </li>
        </ul>
      </section>

      <section aria-labelledby="switch-h" className="rounded-card bg-surface p-pad">
        <h2 id="switch-h" className="mb-1 text-title font-semibold">Public publishing switch</h2>
        <p className="mb-3 max-w-[68ch] text-small text-muted">Turning this on publishes nothing by itself. A video still needs the channel to allow public, the kill switch off, the go-live cutover (production channels) and your approval.</p>
        <PublicSwitchForm allowed={p.allowPublic} phrase={PUBLIC_PHRASE} />
      </section>

      <section aria-labelledby="public-h" className="rounded-card bg-surface p-pad">
        <h2 id="public-h" className="mb-1 text-title font-semibold">A video can go public only when all of these hold</h2>
        <ul data-testid="public-requirements" className="divide-y divide-rule">
          {publicRequirements(p).map((r) => (
            <li key={r.label} className="flex flex-wrap items-center justify-between gap-3 py-2">
              <span className="text-body">{r.label}</span>
              <span className="flex items-center gap-3">
                <Pill tone={r.ok === null ? "neutral" : r.ok ? "positive" : "warning"}>{r.ok === null ? "Per channel" : r.ok ? "Yes" : "Not yet"}</Pill>
                <Link href={r.href} className="text-small underline">{r.where}</Link>
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
