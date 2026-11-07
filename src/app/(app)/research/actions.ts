"use server";

import { refresh } from "next/cache";
import { assertActionOrigin } from "@/lib/auth/action-origin";
import { requireOwner } from "@/lib/auth/require-owner";
import { loadKeyring } from "@/server/db/master-key";
import { getPool } from "@/server/db/pool";
import { addByHandle, decideCandidate, discoverCompetitors, refreshTrends, refreshWatched } from "@/server/db/research";
import { defaultGoogleHttp } from "@/server/db/youtube-channels";

export interface ResearchState {
  ok?: boolean;
  message?: string;
}

// Every action: requireOwner first, then the same-origin check, then the form. All of them only READ from YouTube / Hacker News /
// Wikimedia and write research rows here; nothing is posted, uploaded or sent to the ideas list.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHANNEL = /^[A-Za-z0-9_-]{1,64}$/;
const pick = (f: FormData, k: string, re: RegExp): string | null => {
  const v = f.get(k);
  return typeof v === "string" && re.test(v) ? v : null;
};
const BUSY = "That did not finish. Nothing was changed on YouTube. Try again.";

export async function findCompetitorsAction(_prev: ResearchState, form: FormData): Promise<ResearchState> {
  const owner = await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return { message: origin };
  const row = pick(form, "row", UUID);
  if (!row) return { message: "Pick a channel first." };
  try {
    const r = await discoverCompetitors(getPool(), loadKeyring, defaultGoogleHttp, row, { kind: "session", sessionId: owner.sessionId });
    refresh();
    if (!r.ok) return { message: r.reason };
    const stop = r.stopped ? " Stopped early: the daily search limit (or YouTube quota) was reached." : "";
    return { ok: true, message: `Found ${r.added} new suggestion${r.added === 1 ? "" : "s"} using ${r.searches} search${r.searches === 1 ? "" : "es"}.${stop}` };
  } catch {
    return { message: BUSY };
  }
}

export async function refreshWatchedAction(_prev: ResearchState, form: FormData): Promise<ResearchState> {
  const owner = await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return { message: origin };
  const row = pick(form, "row", UUID);
  if (!row) return { message: "Pick a channel first." };
  try {
    const r = await refreshWatched(getPool(), loadKeyring, defaultGoogleHttp, row, { kind: "session", sessionId: owner.sessionId });
    refresh();
    if (!r.ok) return { message: r.reason };
    return { ok: true, message: `Refreshed ${r.channels} channel${r.channels === 1 ? "" : "s"} (${r.videos} videos).${r.stopped ? " Stopped early: not enough YouTube quota left today." : ""}` };
  } catch {
    return { message: BUSY };
  }
}

export async function refreshTrendsAction(): Promise<ResearchState> {
  const owner = await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return { message: origin };
  try {
    const r = await refreshTrends(getPool(), defaultGoogleHttp, { kind: "session", sessionId: owner.sessionId });
    refresh();
    const warn = r.failed.length ? ` Could not read: ${r.failed.join(", ")}.` : "";
    return { ok: r.failed.length === 0, message: `Hacker News ${r.hackernews}, Wikimedia ${r.wikimedia}.${warn}` };
  } catch {
    return { message: BUSY };
  }
}

export async function decideAction(_prev: ResearchState, form: FormData): Promise<ResearchState> {
  const owner = await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return { message: origin };
  const channel = pick(form, "channel", CHANNEL);
  const competitor = pick(form, "competitor", CHANNEL);
  const decision = form.get("decision");
  if (!channel || !competitor || (decision !== "watch" && decision !== "reject")) return { message: "That choice could not be read." };
  const done = await decideCandidate(getPool(), channel, competitor, decision, owner.sessionId);
  refresh();
  return done ? { ok: true } : { message: "That suggestion is already decided." };
}

export async function addChannelAction(_prev: ResearchState, form: FormData): Promise<ResearchState> {
  const owner = await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return { message: origin };
  const row = pick(form, "row", UUID);
  const ref = form.get("ref");
  if (!row || typeof ref !== "string" || ref.length > 80) return { message: "Pick a channel and give a handle or channel id." };
  try {
    const r = await addByHandle(getPool(), loadKeyring, defaultGoogleHttp, row, ref, owner.sessionId);
    refresh();
    return r.ok ? { ok: true, message: `Now watching ${r.title}.` } : { message: r.reason };
  } catch {
    return { message: BUSY };
  }
}
