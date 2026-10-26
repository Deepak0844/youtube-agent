import { Suspense } from "react";
import { requireOwner } from "@/lib/auth/require-owner";
import { PROVIDERS, vaultNotice } from "@/server/core/provider-keys";
import { loadKeyring } from "@/server/db/master-key";
import { getPool } from "@/server/db/pool";
import { getVaultState, listProviderKeys } from "@/server/db/provider-keys";
import { KeyRow } from "./key-row";

// Provider API keys. The page reads the vault's masked tails only; a key is never sent to the browser after it is saved.
// requireOwner() reads the cookie (request-time data), so it runs inside <Suspense> (cacheComponents).
export default function KeysPage() {
  return (
    <Suspense fallback={<div aria-hidden className="h-96 rounded-card bg-surface" />}>
      <Owned />
    </Suspense>
  );
}

const when = (d: Date): string =>
  `${d.getUTCDate()} ${d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" })} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;

const GROUPS = ["Language model", "Voice", "Stock media"] as const;

async function Owned() {
  await requireOwner();
  const db = getPool();
  const [state, rows] = await Promise.all([getVaultState(db, loadKeyring), listProviderKeys(db)]);
  const notice = vaultNotice(state);
  const byId = new Map(rows.map((r) => [r.id, r]));

  return (
    <div className="flex min-w-0 flex-col gap-layout">
      <header>
        <h1 className="text-page-title font-semibold tracking-tight">Keys</h1>
        <p className="mt-2 max-w-prose text-body text-muted">
          Provider keys live encrypted in the vault. Once saved, a key is never shown again, only its last four characters. Testing a key makes one free request
          (a model list or key check) and never a paid call.
        </p>
      </header>

      {notice.message ? (
        <div role="alert" data-testid="vault-banner" className="rounded-card bg-pill-warning-bg p-pad text-body text-pill-warning-ink">
          <p className="font-semibold">Vault not ready</p>
          <p className="mt-1">{notice.message}</p>
        </div>
      ) : null}

      {GROUPS.map((group) => (
        <section key={group} aria-labelledby={`g-${group.replace(" ", "-")}`} className="flex flex-col gap-gap">
          <h2 id={`g-${group.replace(" ", "-")}`} className="text-small font-semibold tracking-wide text-faint uppercase">
            {group === "Language model" ? "Language models" : group}
          </h2>
          <ul className="m-0 flex list-none flex-col gap-gap p-0">
            {PROVIDERS.filter((p) => p.role === group).map((p) => {
              const r = byId.get(p.id)!;
              return (
                <KeyRow
                  key={p.id}
                  id={p.id}
                  label={p.label}
                  note={p.note}
                  shapeHint={p.shapeHint}
                  isSet={r.isSet}
                  tail={r.tail}
                  savedLabel={r.updatedAt ? `saved ${when(r.updatedAt)}` : ""}
                  lastTest={r.lastTest ? { result: r.lastTest.result, label: when(r.lastTest.at) } : null}
                  canSave={notice.canSave}
                />
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
