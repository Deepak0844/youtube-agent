import { Suspense } from "react";
import { requireOwner } from "@/lib/auth/require-owner";
import { SCOPE_LABEL } from "@/server/core/api-token";
import { listApiTokens } from "@/server/db/api-tokens";
import { getPool } from "@/server/db/pool";
import { Button } from "@/ui/primitives/button";
import { Pill } from "@/ui/primitives/pill";
import { revokeTokenAction } from "./actions";
import { TokenForm } from "./token-form";

export default function TokensPage() {
  return (
    <Suspense fallback={<div aria-hidden className="h-96 rounded-card bg-surface" />}>
      <Owned />
    </Suspense>
  );
}

const fmt = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });

async function Owned() {
  await requireOwner();
  const tokens = await listApiTokens(getPool());
  return (
    <div className="flex flex-col gap-layout">
      <header className="flex flex-col gap-1">
        <h1 className="text-page-title font-semibold tracking-tight">API tokens</h1>
        <p className="text-body text-muted">For your own scripts. A token can read status and create drafts, nothing more: it cannot pass gates, change safety settings, or reach settings, keys or tokens.</p>
      </header>
      <section aria-labelledby="new-h" className="rounded-card bg-surface p-pad">
        <h2 id="new-h" className="mb-4 text-title font-semibold">
          New token
        </h2>
        <TokenForm />
      </section>
      <section aria-labelledby="list-h" className="rounded-card bg-surface p-pad">
        <h2 id="list-h" className="mb-4 text-title font-semibold">
          Your tokens
        </h2>
        {tokens.length === 0 ? <p className="text-body text-muted">No tokens yet.</p> : null}
        <ul className="divide-y divide-rule">
          {tokens.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="flex min-w-0 flex-col gap-1">
                <p className="text-body font-medium">
                  {t.name} <span className="font-mono text-small text-muted">{t.prefix}…</span>
                </p>
                <p className="text-small text-muted">
                  {t.scopes.map((s) => SCOPE_LABEL[s]).join(", ")} · {t.draftsToday}/{t.dailyDraftCap} drafts today · made {fmt.format(t.createdAt)} · {t.lastUsedAt ? `used ${fmt.format(t.lastUsedAt)}` : "never used"}
                </p>
              </div>
              {t.revokedAt ? (
                <Pill tone="negative">Revoked</Pill>
              ) : (
                <form action={revokeTokenAction}>
                  <input type="hidden" name="id" value={t.id} />
                  <Button type="submit" variant="secondary">
                    Revoke
                  </Button>
                </form>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
