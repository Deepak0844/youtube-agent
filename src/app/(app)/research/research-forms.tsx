"use client";

import { useActionState } from "react";
import { Button } from "@/ui/primitives/button";
import { Label } from "@/ui/primitives/label";
import { addChannelAction, decideAction, findCompetitorsAction, refreshTrendsAction, refreshWatchedAction, type ResearchState } from "./actions";

const field = "h-10 w-full min-w-0 rounded-card border border-line bg-surface px-3 text-body";

function Msg({ s, id }: { s: ResearchState; id: string }) {
  if (!s.message) return null;
  return (
    <p role={s.ok ? "status" : "alert"} data-testid={id} className={s.ok ? "text-body text-pill-positive-ink" : "text-body text-pill-negative-ink"}>
      {s.message}
    </p>
  );
}

export function ChannelPicker({ channels, selected }: { channels: Array<{ channelId: string; title: string }>; selected: string }) {
  return (
    <form method="get" className="flex flex-wrap items-end gap-4">
      <div className="flex min-w-0 flex-col gap-2">
        <Label htmlFor="r-channel">Channel</Label>
        <select id="r-channel" name="c" defaultValue={selected} className={field}>
          {channels.map((c) => <option key={c.channelId} value={c.channelId}>{c.title}</option>)}
        </select>
      </div>
      <Button type="submit" variant="secondary">Show</Button>
    </form>
  );
}

export function FindButtons({ row }: { row: string }) {
  const [found, find, finding] = useActionState<ResearchState, FormData>(findCompetitorsAction, {});
  const [mined, mine, mining] = useActionState<ResearchState, FormData>(refreshWatchedAction, {});
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <form action={find}>
          <input type="hidden" name="row" value={row} />
          <Button type="submit" disabled={finding}>{finding ? "Looking…" : "Find competitors"}</Button>
        </form>
        <form action={mine}>
          <input type="hidden" name="row" value={row} />
          <Button type="submit" variant="secondary" disabled={mining}>{mining ? "Refreshing…" : "Refresh and mine"}</Button>
        </form>
      </div>
      <Msg s={found} id="find-msg" />
      <Msg s={mined} id="mine-msg" />
    </div>
  );
}

export function TrendsButton() {
  const [state, action, pending] = useActionState<ResearchState, FormData>(() => refreshTrendsAction(), {});
  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <Button type="submit" variant="secondary" loading={pending}>{pending ? "Reading…" : "Refresh trends"}</Button>
      <Msg s={state} id="trends-msg" />
    </form>
  );
}

export function DecideButtons({ channel, competitor, title }: { channel: string; competitor: string; title: string }) {
  const [state, action, pending] = useActionState<ResearchState, FormData>(decideAction, {});
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="channel" value={channel} />
      <input type="hidden" name="competitor" value={competitor} />
      <Button type="submit" name="decision" value="watch" loading={pending} aria-label={`Watch ${title}`}>Watch</Button>
      <Button type="submit" name="decision" value="reject" variant="ghost" loading={pending} aria-label={`Not relevant: ${title}`}>Not relevant</Button>
      {state.message ? <span role="alert" className="text-small text-pill-negative-ink">{state.message}</span> : null}
    </form>
  );
}

export function AddChannelForm({ row }: { row: string }) {
  const [state, action, pending] = useActionState<ResearchState, FormData>(addChannelAction, {});
  return (
    <form action={action} className="flex flex-wrap items-end gap-4">
      <input type="hidden" name="row" value={row} />
      <div className="flex min-w-0 flex-col gap-2">
        <Label htmlFor="r-ref">Channel handle or id</Label>
        <input id="r-ref" name="ref" type="text" required maxLength={80} placeholder="@handle or UC…" className={field} />
      </div>
      <Button type="submit" loading={pending}>Add channel</Button>
      <Msg s={state} id="add-msg" />
    </form>
  );
}
