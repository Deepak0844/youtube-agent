import { Suspense } from "react";
import { isAllowedHost, parseAllowedHosts } from "@/lib/auth/policy";
import { requireOwner } from "@/lib/auth/require-owner";
import { maskClientId, redirectUriFor } from "@/server/core/google-app";
import { getOwnGoogleApp, listLegacyGoogleApps } from "@/server/db/google-app";
import { loadKeyring } from "@/server/db/master-key";
import { getPool } from "@/server/db/pool";
import { vaultStatus } from "@/server/db/vault";
import { Pill } from "@/ui/primitives/pill";
import { CopyButton, FormatTest, GoogleForm, VaultBanner, type VaultState } from "./google-form";

// Session read happens inside <Suspense> (cacheComponents). No secret is ever read here: only the masked hint.
export default function GoogleSettingsPage() {
  return (
    <Suspense fallback={<div aria-hidden className="h-96 rounded-card bg-surface" />}>
      <Owned />
    </Suspense>
  );
}

const STEPS = [
  ["Make a project", "In Google Cloud Console, create a project just for this studio."],
  ["Switch on the YouTube Data API", "APIs and services, Library, YouTube Data API v3, Enable."],
  ["Set up the consent screen", "Add yourself as a test user. Keep the app in testing until you are ready."],
  ["Create a web application client", "Credentials, Create credentials, OAuth client ID, type Web application (not Desktop). Paste the redirect address from the right into Authorised redirect URIs."],
  ["Copy the client ID and secret here", "The secret is shown once by Google. Paste it on the left; it goes straight into the vault."],
] as const;

async function Owned() {
  await requireOwner();
  const pool = getPool();
  const [vault, app, legacy] = await Promise.all([vaultStatus(pool, loadKeyring).catch(() => ({ status: "unreadable" as const })), getOwnGoogleApp(pool), listLegacyGoogleApps(pool)]);
  const redirect = redirectUriFor(process.env.APP_URL);
  const hostWarn =
    redirect.ok && !isAllowedHost(new URL(redirect.uri).host, parseAllowedHosts(process.env.ALLOWED_HOSTS))
      ? "The host in APP_URL is not in ALLOWED_HOSTS, so this app would refuse the address Google sends you back to."
      : null;
  const v: VaultState = vault.status;

  return (
    <div className="flex flex-col gap-layout">
      <header className="flex flex-col gap-1">
        <h1 className="text-page-title font-semibold tracking-tight">Google app</h1>
        <p className="text-body text-muted">Your own Google Cloud app. Channels are connected through it, so quota and audit status are yours alone.</p>
      </header>

      <VaultBanner vault={v} />

      <div className="grid gap-layout lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <section aria-labelledby="creds-h" className="flex min-w-0 flex-col gap-5 rounded-card bg-surface p-pad">
          <div className="flex items-center justify-between gap-3">
            <h2 id="creds-h" className="text-title font-semibold">
              Credentials
            </h2>
            {app ? <Pill tone={app.secretStored ? "positive" : "warning"}>{app.secretStored ? "Saved" : "Secret missing"}</Pill> : <Pill>Not set up</Pill>}
          </div>
          <GoogleForm vault={v} maskedId={app ? maskClientId(app.clientId) : null} secretHint={app?.secretHint ?? ""} secretStored={app?.secretStored ?? false} />
        </section>

        <div className="flex min-w-0 flex-col gap-layout">
          <section aria-labelledby="redirect-h" className="flex flex-col gap-3 rounded-card bg-surface p-pad">
            <h2 id="redirect-h" className="text-title font-semibold">
              Redirect address
            </h2>
            {redirect.ok ? (
              <>
                <p className="text-small text-faint">Paste this into Authorised redirect URIs in Google, exactly as shown.</p>
                <div className="flex items-center gap-3">
                  <code data-testid="redirect-uri" className="min-w-0 flex-1 rounded-control bg-ground px-4 py-2 font-mono text-small break-all text-text">
                    {redirect.uri}
                  </code>
                  <CopyButton value={redirect.uri} label="Copy redirect address" />
                </div>
                {hostWarn ? <p role="alert" className="text-small text-pill-warning-ink">{hostWarn}</p> : null}
              </>
            ) : (
              <p role="alert" className="text-body text-negative">
                {redirect.error}
              </p>
            )}
            <p className="text-small text-faint">Daily quota used: – (unknown until channels are connected).</p>
          </section>

          <section aria-labelledby="test-h" className="flex flex-col gap-3 rounded-card bg-surface p-pad">
            <h2 id="test-h" className="text-title font-semibold">
              Check
            </h2>
            <FormatTest disabled={!app || v !== "ok"} />
          </section>
        </div>
      </div>

      <section aria-labelledby="guide-h" className="rounded-card bg-surface p-pad">
        <h2 id="guide-h" className="text-title font-semibold">
          Setting it up in Google
        </h2>
        <ol className="mt-4 grid gap-4 sm:grid-cols-2">
          {STEPS.map(([title, body], i) => (
            <li key={title} className="flex min-w-0 gap-4">
              <span aria-hidden className="font-mono text-kpi leading-none text-faint tabular-nums">
                {i + 1}
              </span>
              <span className="min-w-0">
                <span className="block text-body font-semibold">{title}</span>
                <span className="mt-1 block text-small text-muted">{body}</span>
              </span>
            </li>
          ))}
        </ol>
      </section>

      {legacy.length > 0 ? (
        <section aria-labelledby="legacy-h" className="rounded-card bg-surface p-pad">
          <h2 id="legacy-h" className="text-title font-semibold">
            Imported app (read only)
          </h2>
          <ul className="mt-3 flex flex-col gap-2">
            {legacy.map((l) => (
              <li key={l.clientId} className="font-mono text-small text-muted">
                {maskClientId(l.clientId)}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
