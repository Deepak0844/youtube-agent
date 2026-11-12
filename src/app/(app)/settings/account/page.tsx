import { Suspense } from "react";
import { PageSkeleton } from "@/ui/states/page-skeleton";
import { requireOwner } from "@/lib/auth/require-owner";
import { deviceLabel } from "@/server/core/account-view";
import { listSessions } from "@/server/db/auth";
import { ownerUsername } from "@/server/db/owner";
import { getPool } from "@/server/db/pool";
import { Pill } from "@/ui/primitives/pill";
import { PasswordForm, SignOutOneForm, SignOutOthersForm } from "./account-forms";

export const metadata = { title: "Account" };

export default function AccountPage() {
  return (
    <Suspense fallback={<PageSkeleton variant="form" />}>
      <Owned />
    </Suspense>
  );
}

const fmt = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });

async function Owned() {
  const { sessionId } = await requireOwner();
  const db = getPool();
  const [name, sessions] = await Promise.all([ownerUsername(db), listSessions(db)]);
  const others = sessions.filter((s) => s.id !== sessionId);
  return (
    <div className="flex flex-col gap-layout">
      <header className="flex flex-col gap-1">
        <h1 className="text-page-title font-semibold tracking-tight">Account</h1>
        <p className="text-body text-muted">
          Signed in as <strong data-testid="owner-name">{name ?? "the owner"}</strong>. Changing the password signs every other sign-in out.
        </p>
      </header>

      <section aria-labelledby="pw-h" className="rounded-card border border-border bg-surface p-pad">
        <h2 id="pw-h" className="mb-4 text-title font-semibold">Change password</h2>
        <PasswordForm />
      </section>

      <section aria-labelledby="sessions-h" className="rounded-card border border-border bg-surface p-pad">
        <h2 id="sessions-h" className="mb-1 text-title font-semibold">Where you are signed in</h2>
        <p className="mb-4 text-small text-muted">Times are IST. If you do not recognise one, sign it out and change your password.</p>
        <ul data-testid="sessions" className="divide-y divide-rule">
          {sessions.map((s) => {
            const label = deviceLabel(s.userAgent);
            const current = s.id === sessionId;
            return (
              <li key={s.id} data-testid="session-row" className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <p className="text-body font-medium">
                    {label} {current ? <Pill tone="positive">This device</Pill> : null}
                  </p>
                  <p className="text-small text-muted">
                    Signed in {fmt.format(s.createdAt)} · last active {fmt.format(s.lastSeenAt)}{s.ip ? ` · ${s.ip}` : ""}
                  </p>
                </div>
                {current ? null : <SignOutOneForm id={s.id} label={label} />}
              </li>
            );
          })}
        </ul>
        <div className="mt-4">
          <SignOutOthersForm others={others.length} />
        </div>
      </section>
    </div>
  );
}
