import { Suspense } from "react";
import { requireOwner } from "@/lib/auth/require-owner";
import { getPool } from "@/server/db/pool";
import { listAccounts } from "@/server/db/youtube-channels";
import { Button } from "@/ui/primitives/button";
import { Pill } from "@/ui/primitives/pill";
import { confirmChannelAction, connectChannelAction, disconnectChannelAction } from "./actions";

export default function ChannelsPage({ searchParams }: PageProps<"/settings/channels">) {
  return (
    <Suspense fallback={<div aria-hidden className="h-96 rounded-card bg-surface" />}>
      <Owned searchParams={searchParams} />
    </Suspense>
  );
}

const MESSAGES: Record<string, string> = {
  no_app: "Save your Google app details first (Settings, Google app).",
  bad_app_url: "APP_URL is not a valid address for Google to send you back to.",
  state: "That sign-in link was not valid or had expired. Start again.",
  denied: "Google sign-in was cancelled.",
  exchange: "Google did not accept the sign-in. Check the client ID, secret and redirect address, then try again.",
  no_refresh_token: "Google did not give a long-lived token. Start again and allow everything asked.",
  scopes: "Some permissions were left unticked. Start again and tick them all.",
  profile: "Could not read your Google profile. Try again.",
  no_channel: "That Google account has no YouTube channel.",
};

const STATUS = { connected: ["positive", "Connected"], needs_reconnect: ["warning", "Needs reconnect"], unconfirmed: ["neutral", "Not confirmed yet"] } as const;

async function Owned({ searchParams }: { searchParams: PageProps<"/settings/channels">["searchParams"] }) {
  await requireOwner();
  const sp = await searchParams;
  const err = typeof sp.error === "string" ? (MESSAGES[sp.error] ?? "Something went wrong. Try again.") : null;
  const accounts = await listAccounts(getPool());

  return (
    <div className="flex flex-col gap-layout">
      <header className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-page-title font-semibold tracking-tight">YouTube channels</h1>
          <p className="text-body text-muted">Channels connected through your own Google app. Nothing is uploaded from here.</p>
        </div>
        <form action={connectChannelAction}>
          <Button type="submit">Connect channel</Button>
        </form>
      </header>

      {err ? (
        <p role="alert" className="rounded-card bg-surface p-pad text-body text-negative">
          {err}
        </p>
      ) : null}
      {sp.connected ? <p className="rounded-card bg-surface p-pad text-body text-muted">Connected. Check the channel below, then confirm it is yours.</p> : null}

      {accounts.length === 0 ? <p className="rounded-card bg-surface p-pad text-body text-muted">No channels yet.</p> : null}
      {accounts.map((a) => (
        <section key={a.id} className="flex flex-col gap-3 rounded-card bg-surface p-pad">
          <h2 className="text-title font-semibold">{a.email || "Google account"}</h2>
          <ul className="flex flex-col gap-3">
            {a.channels.map((c) => {
              const [tone, word] = STATUS[c.status];
              return (
                <li key={c.id} className="flex flex-wrap items-center gap-3">
                  <span className="min-w-0 flex-1">
                    <span className="block text-body font-semibold">{c.title || "Untitled channel"}</span>
                    <span className="block font-mono text-small text-faint">{c.channelId}</span>
                  </span>
                  <Pill tone={tone}>{word}</Pill>
                  {c.status === "unconfirmed" ? (
                    <form action={confirmChannelAction}>
                      <input type="hidden" name="id" value={c.id} />
                      <Button type="submit">Yes, this is my channel</Button>
                    </form>
                  ) : null}
                  {c.status === "needs_reconnect" ? (
                    <form action={connectChannelAction}>
                      <Button type="submit" variant="secondary">
                        Reconnect
                      </Button>
                    </form>
                  ) : null}
                  <form action={disconnectChannelAction}>
                    <input type="hidden" name="id" value={c.id} />
                    <Button type="submit" variant="destructive">
                      Disconnect
                    </Button>
                  </form>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
