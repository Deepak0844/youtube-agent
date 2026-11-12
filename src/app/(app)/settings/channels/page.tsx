import { Suspense } from "react";
import { PageSkeleton } from "@/ui/states/page-skeleton";
import { requireOwner } from "@/lib/auth/require-owner";
import { GOOGLE_SCOPES, scopeLabel } from "@/server/core/youtube-oauth";
import { getPool } from "@/server/db/pool";
import { listAccounts } from "@/server/db/youtube-channels";
import { Button } from "@/ui/primitives/button";
import { Pill } from "@/ui/primitives/pill";
import { PRESETS, STYLE_IDS } from "../../../../../remotion/kit/presets";
import { LANGUAGE_ORDER, LANGUAGE_WORDS } from "@/server/core/videos-view";
import { Input } from "@/ui/primitives/input";
import { Label } from "@/ui/primitives/label";
import { RefreshDescription } from "./refresh-description";
import { confirmChannelAction, connectChannelAction, disconnectChannelAction, saveChannelSettingsAction } from "./actions";

export const metadata = { title: "Channels" };

export default function ChannelsPage({ searchParams }: PageProps<"/settings/channels">) {
  return (
    <Suspense fallback={<PageSkeleton variant="form" />}>
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
  profile: "Could not read your Google profile. Try again.",
  no_channel: "That Google account has no YouTube channel.",
};

const STATUS = { connected: ["positive", "Connected"], needs_reconnect: ["warning", "Needs reconnect"], unconfirmed: ["neutral", "Not confirmed yet"] } as const;

async function Owned({ searchParams }: { searchParams: PageProps<"/settings/channels">["searchParams"] }) {
  await requireOwner();
  const sp = await searchParams;
  const known = GOOGLE_SCOPES.map(scopeLabel);
  const missing = (typeof sp.missing === "string" ? sp.missing.split(",") : []).filter((m) => known.includes(m));
  const err =
    sp.error === "scopes"
      ? `Some permissions were left unticked${missing.length ? ` (${missing.join(", ")})` : ""}. Start again and tick them all.`
      : typeof sp.error === "string"
        ? (MESSAGES[sp.error] ?? "Something went wrong. Try again.")
        : null;
  const accounts = await listAccounts(getPool());

  return (
    <div className="grid min-w-0 gap-layout xl:grid-cols-2 xl:items-start">
      <header className="xl:col-span-2 flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-page-title font-semibold tracking-tight">YouTube channels</h1>
          <p className="text-body text-muted">Channels connected through your own Google app. Nothing is uploaded from here.</p>
        </div>
        <form action={connectChannelAction}>
          <Button type="submit">Connect channel</Button>
        </form>
      </header>

      {err ? (
        <p role="alert" className="rounded-card border border-border bg-surface p-pad text-body text-negative">
          {err}
        </p>
      ) : null}
      {sp.connected ? <p className="rounded-card border border-border bg-surface p-pad text-body text-muted">Connected. Check the channel below, then confirm it is yours.</p> : null}

      {accounts.length === 0 ? <p className="rounded-card border border-border bg-surface p-pad text-body text-muted">No channels yet.</p> : null}
      {accounts.map((a) => (
        <section key={a.id} className="flex min-w-0 flex-col gap-3 rounded-card border border-border bg-surface p-pad">
          <h2 className="min-w-0 text-title font-semibold [overflow-wrap:anywhere]">{a.email || "Google account"}</h2>
          <ul className="flex flex-col gap-3">
            {a.channels.map((c) => {
              const [tone, word] = STATUS[c.status];
              return (
                <li key={c.id} className="flex flex-wrap items-center gap-3">
                  <span className="min-w-0 flex-1">
                    <span className="block text-body font-semibold">{c.title || "Untitled channel"}</span>
                    <span className="block font-mono text-small text-faint [overflow-wrap:anywhere]">{c.channelId}</span>
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
                  {c.status === "connected" ? <RefreshDescription id={c.id} /> : null}
                  <details className="basis-full">
                    <summary className="min-h-11 cursor-pointer py-2 text-body font-medium">Safety and defaults</summary>
                    <form action={saveChannelSettingsAction} className="flex flex-col gap-4 pt-2">
                      <input type="hidden" name="id" value={c.id} />
                      <p className="max-w-[60ch] text-small text-muted">
                        Google may force uploads from an unaudited app to private, whatever is chosen here. Nothing goes public unless
                        &quot;Allow public&quot; is on for this channel and in the global settings.
                      </p>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <div className="flex flex-col gap-2">
                          <Label htmlFor={`max-${c.id}`}>Uploads per day (most)</Label>
                          <Input id={`max-${c.id}`} name="maxUploadsPerDay" type="number" inputMode="numeric" min={0} max={50} step={1} required defaultValue={c.settings.maxUploadsPerDay} />
                        </div>
                        <div className="flex flex-col gap-2">
                          <Label htmlFor={`gap-${c.id}`}>Hours between uploads (least)</Label>
                          <Input id={`gap-${c.id}`} name="minHoursBetweenUploads" type="number" inputMode="numeric" min={0} max={168} step={1} required defaultValue={c.settings.minHoursBetweenUploads} />
                        </div>
                        <div className="flex flex-col gap-2">
                          <Label htmlFor={`lang-${c.id}`}>Default language</Label>
                          <select id={`lang-${c.id}`} name="language" defaultValue={c.settings.language} className="min-h-11 rounded-card border border-control bg-surface px-3 text-body">
                            <option value="">Not set</option>
                            {LANGUAGE_ORDER.map((l) => <option key={l} value={l}>{LANGUAGE_WORDS[l]}</option>)}
                          </select>
                        </div>
                        <div className="flex flex-col gap-2">
                          <Label htmlFor={`cat-${c.id}`}>YouTube category number</Label>
                          <Input id={`cat-${c.id}`} name="categoryId" type="number" inputMode="numeric" min={1} max={99} step={1} required defaultValue={c.settings.categoryId} />
                          <span className="text-small text-faint">27 is Education.</span>
                        </div>
                        <div className="flex flex-col gap-2 sm:col-span-2">
                          <Label htmlFor={`style-${c.id}`}>Default style for new videos</Label>
                          <select id={`style-${c.id}`} name="defaultStyle" defaultValue={c.settings.defaultStyle ?? ""} className="min-h-11 rounded-card border border-control bg-surface px-3 text-body">
                            <option value="">No default</option>
                            {STYLE_IDS.map((id) => <option key={id} value={id}>{PRESETS[id].label}</option>)}
                          </select>
                        </div>
                      </div>
                      <fieldset className="flex flex-col gap-1">
                        <legend className="text-small font-medium text-muted">Made for kids (default for this channel)</legend>
                        <label className="flex min-h-11 items-center gap-3 text-body">
                          <input type="radio" name="madeForKids" value="no" defaultChecked={!c.settings.madeForKids} className="size-5 accent-[var(--text)]" />
                          No, not made for kids
                        </label>
                        <label className="flex min-h-11 items-center gap-3 text-body">
                          <input type="radio" name="madeForKids" value="yes" defaultChecked={c.settings.madeForKids} className="size-5 accent-[var(--text)]" />
                          Yes, made for kids
                        </label>
                      </fieldset>
                      <label className="flex min-h-11 items-center gap-3 text-body">
                        <input type="checkbox" name="synthetic" defaultChecked={c.settings.synthetic} className="size-5 accent-[var(--text)]" />
                        Say the video uses altered or AI-made content (disclosure)
                      </label>
                      <label className="flex min-h-11 items-center gap-3 text-body">
                        <input type="checkbox" name="allowPublic" defaultChecked={c.settings.allowPublic} className="size-5 accent-[var(--text)]" />
                        Allow public uploads on this channel (off keeps it private or unlisted)
                      </label>
                      <label className="flex min-h-11 items-center gap-3 text-body">
                        <input type="checkbox" name="production" defaultChecked={c.settings.production} className="size-5 accent-[var(--text)]" />
                        Production channel (no uploads until the go-live cutover in System settings)
                      </label>
                      <div>
                        <Button type="submit">Save channel settings</Button>
                      </div>
                    </form>
                  </details>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
