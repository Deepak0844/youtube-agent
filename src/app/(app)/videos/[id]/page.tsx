import Link from "next/link";
import { Suspense } from "react";
import { z } from "zod";
import { requireOwner } from "@/lib/auth/require-owner";
import { describeDetail } from "@/server/core/audit-view";
import { microToUsd } from "@/server/core/llm-catalog";
import type { StageName } from "@/server/core/pipeline-plan";
import { scriptSchema } from "@/server/core/script-contract";
import { estimateLabel, parseTab, rerunCostNote, rerunOffered, SEVERITY_WORDS, STAGE_LABELS, STATE_WORDS, TABS, type StageView, type TabId, type UiState } from "@/server/core/video-page-view";
import { FORMAT_WORDS, KIND_WORDS, LANGUAGE_WORDS, STATUS_WORDS } from "@/server/core/videos-view";
import { getPool } from "@/server/db/pool";
import { jobCheckers } from "../../queue/job-checkers";
import { loadQueue } from "@/server/db/queue-data";
import { loadVideoPage, type VideoPage } from "@/server/db/video-page";
import { ageLabel, GateCard } from "../../queue/gate-card";
import { DecisionCard } from "../../queue/decision-card";
import { CancelForm } from "../../queue/forms";
import { LiveFeed } from "../../queue/live-feed";
import { LogTail } from "@/ui/domain/log-tail";
import { VideoBox } from "@/ui/domain/video-box";
import { Pill } from "@/ui/primitives/pill";
import { Skeleton } from "@/ui/primitives/skeleton";
import { RerunForm, SceneButtons } from "./controls";

// The video page (Doc 4 /videos/[id]): where it is now, what it cost, and the content of each step, one tab at a time
// (?tab=). Read only except the buttons: Run again, Cancel, the gate card (all owner-only server actions) and the free scene checks.
export default function VideoPage({ params, searchParams }: PageProps<"/videos/[id]">) {
  return (
    <Suspense fallback={<Skeleton aria-hidden className="h-96 w-full rounded-card" />}>
      <Owned params={params} searchParams={searchParams} />
    </Suspense>
  );
}

const STATE_TONE: Record<UiState, "neutral" | "positive" | "negative" | "warning"> = { pending: "neutral", running: "neutral", done: "positive", failed: "negative", needs_you: "warning" };
const usd = (micro: number) => `$${microToUsd(micro)}`;
const dt = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
const asObj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

async function Owned({ params, searchParams }: { params: PageProps<"/videos/[id]">["params"]; searchParams: PageProps<"/videos/[id]">["searchParams"] }) {
  await requireOwner();
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return <Missing />;
  const tab = parseTab((await searchParams).tab);
  const db = getPool();
  const p = await loadVideoPage(db, id.data);
  if (!p) return <Missing />;
  const live = p.head.status === "active" || p.head.status === "waiting";
  // The gate or parked-decision card is the /queue card for this one video: same buttons, same checks.
  const q = live && (p.openGate || p.stages.some((s) => s.state === "needs_you")) ? await loadQueue(db, new Set(Object.keys(jobCheckers())), { videoId: id.data }) : null;
  const card = q?.items[0];
  const status = STATUS_WORDS[p.head.status];

  return (
    <div className="flex min-w-0 flex-col gap-layout">
      <header className="flex min-w-0 flex-col gap-3">
        <Link href="/videos" className="text-small text-muted underline">Library</Link>
        <h1 lang={p.head.language} className="m-0 text-page-title font-semibold tracking-tight [overflow-wrap:anywhere]">{p.head.topic}</h1>
        <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-body text-muted">
          <Pill tone={status.tone}>{status.label}</Pill>
          <span>{LANGUAGE_WORDS[p.head.language]}</span>
          <span>{KIND_WORDS[p.head.kind]} {FORMAT_WORDS[p.head.format].toLowerCase()}</span>
          <span data-testid="total-spend" className="tabular-nums">{usd(p.spend.totalMicroUsd)} spent</span>
          <span>Started {dt.format(new Date(p.head.createdAt))} UTC</span>
        </p>
      </header>

      <LiveFeed />
      <StageStrip p={p} live={live} />

      {card ? card.kind === "gate" ? <GateCard item={card} index={0} /> : <DecisionCard item={card} /> : null}
      {live && !card ? <CancelForm videoId={p.head.id} topic={p.head.topic} /> : null}

      {p.videoSrc ? (
        <VideoBox aspect="9:16" label="Final video">
          <video controls preload="metadata" src={p.videoSrc} poster={p.posterSrc ?? undefined} aria-label="Final video" className="size-full object-contain" />
        </VideoBox>
      ) : null}

      <nav aria-label="Video sections" className="flex min-w-0 gap-5 overflow-x-auto border-b border-rule">
        {TABS.map((t) => (
          <Link key={t.id} href={`/videos/${p.head.id}?tab=${t.id}`} scroll={false} aria-current={tab === t.id ? "page" : undefined} className="-mb-px inline-flex min-h-11 items-center border-b-2 border-transparent text-body text-muted aria-[current=page]:border-text aria-[current=page]:text-text sm:min-h-9">
            {t.label}
          </Link>
        ))}
      </nav>
      <section aria-label={TABS.find((t) => t.id === tab)!.label} data-testid="tab-panel" data-tab={tab} className="flex min-w-0 flex-col gap-4">
        <Panel tab={tab} p={p} />
      </section>
    </div>
  );
}

// A bad or unknown id still renders a page with its own heading (not a bare 404).
function Missing() {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <h1 className="m-0 text-page-title font-semibold tracking-tight">Video not found</h1>
      <p className="m-0 text-body text-muted">There is no video with this address.</p>
      <Link href="/videos" className="text-small text-muted underline">Library</Link>
    </div>
  );
}

function StageStrip({ p, live }: { p: VideoPage; live: boolean }) {
  return (
    <section aria-label="Steps" className="flex min-w-0 flex-col gap-3 rounded-card bg-surface p-pad">
      <ol data-testid="stage-strip" className="m-0 grid list-none gap-3 p-0 sm:grid-cols-2">
        {p.stages.map((s: StageView) => {
          const again = rerunOffered(p.runStatus[s.stage as StageName], p.head.status);
          return (
            <li key={s.stage} data-stage={s.stage} data-state={s.state} className="flex min-w-0 flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-body font-medium">{s.label}</span>
                <Pill tone={STATE_TONE[s.state]}>{STATE_WORDS[s.state]}</Pill>
              </div>
              <p className="m-0 text-small text-muted [overflow-wrap:anywhere]">{s.detail}{s.timeLeft ? ` · ${s.timeLeft}` : ""}</p>
              {s.state === "running" && s.percent !== null ? <progress value={s.percent} max={100} aria-label={`${s.label} progress`} className="h-1 w-full" /> : null}
              {live && again ? <RerunForm videoId={p.head.id} stage={s.stage} label={STAGE_LABELS[s.stage as StageName]} estimate={estimateLabel(p.estimates[s.stage as StageName] ?? null)} costNote={rerunCostNote(s.stage as StageName, p.costPlanTotalMicroUsd)} /> : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

const Empty = ({ children }: { children: React.ReactNode }) => <p data-testid="empty" className="m-0 max-w-[60ch] rounded-card bg-surface p-pad text-body text-muted">{children}</p>;
const H = ({ children }: { children: React.ReactNode }) => <h2 className="m-0 text-title font-semibold">{children}</h2>;

function Panel({ tab, p }: { tab: TabId; p: VideoPage }) {
  const lang = p.head.language;
  switch (tab) {
    case "script": {
      if (!p.script) return <Empty>No script yet. It appears here once the draft step finishes.</Empty>;
      const s = scriptSchema.safeParse(p.script.body);
      return (
        <>
          <p className="m-0 flex flex-wrap items-center gap-2"><Pill tone={p.script.approved ? "positive" : "warning"}>{p.script.approved ? "Approved script" : "Draft, not approved yet"}</Pill><span className="text-small text-muted">version {p.script.version}</span></p>
          {s.success ? (
            <>
              <H>{s.data.title}</H>
              <p lang={lang} data-testid="script-text" className="m-0 max-w-[68ch] whitespace-pre-wrap text-body [overflow-wrap:anywhere]">{s.data.narration}</p>
              {s.data.description ? <p className="m-0 max-w-[68ch] text-body text-muted [overflow-wrap:anywhere]">{s.data.description}</p> : null}
              <h3 className="m-0 text-section font-medium">Scenes ({s.data.beats.length})</h3>
              <BeatList beats={s.data.beats} />
            </>
          ) : (
            <pre className="m-0 max-w-full overflow-x-auto whitespace-pre-wrap text-small [overflow-wrap:anywhere]">{JSON.stringify(p.script.body, null, 2)}</pre>
          )}
        </>
      );
    }
    case "beats": {
      const b = asObj(p.beats).beats;
      return (
        <>
          {Array.isArray(b) && b.length > 0 ? <BeatList beats={b} /> : <Empty>No beats yet. They are written together with the script.</Empty>}
          <div data-testid="scene-actions" className="flex min-w-0 flex-col gap-2 rounded-card bg-surface p-pad">
            <H>Scenes</H>
            <p className="m-0 text-body text-muted">Both buttons are free: no model is called and nothing is spent.</p>
            <SceneButtons videoId={p.head.id} />
          </div>
        </>
      );
    }
    case "evidence": {
      const s = scriptSchema.safeParse(p.script?.body);
      const claims = s.success ? s.data.evidence : [];
      if (claims.length === 0 && !p.evidence) return <Empty>No evidence yet. Sources show here once the script lists them.</Empty>;
      return (
        <>
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {claims.map((c, i) => (
              <li key={i} className="flex min-w-0 flex-col gap-1 text-body">
                <span className="[overflow-wrap:anywhere]">{c.text}</span>
                <span className="text-small text-muted [overflow-wrap:anywhere]">{c.kind === "sourced" ? `Sourced: ${c.source_url} - "${c.quote}"` : `Calculated: ${c.method}`}</span>
              </li>
            ))}
          </ul>
          {p.evidence?.fileSrc ? <a className="text-body underline" href={p.evidence.fileSrc} target="_blank" rel="noreferrer">Open the evidence file</a> : null}
        </>
      );
    }
    case "titles": {
      const t = asObj(p.titles);
      const list = (Array.isArray(p.titles) ? p.titles : Array.isArray(t.titles) ? t.titles : []).filter((x): x is string => typeof x === "string");
      const m = asObj(p.metadata);
      if (list.length === 0 && !p.metadata) return <Empty>No titles yet. Titles and the description appear after the video is checked.</Empty>;
      return (
        <>
          {list.length > 0 ? <ol className="m-0 flex flex-col gap-1 pl-5 text-body">{list.map((x, i) => <li key={i} lang={lang} className="[overflow-wrap:anywhere]">{x}</li>)}</ol> : null}
          {typeof m.title === "string" ? <p lang={lang} className="m-0 text-section font-medium [overflow-wrap:anywhere]">{m.title}</p> : null}
          {typeof m.description === "string" ? <p className="m-0 max-w-[68ch] text-body text-muted [overflow-wrap:anywhere]">{m.description}</p> : null}
        </>
      );
    }
    case "cost": {
      const items = Array.isArray(asObj(p.costPlan).items) ? (asObj(p.costPlan).items as Array<Record<string, unknown>>) : [];
      return (
        <>
          <p className="m-0 text-body"><span data-testid="spend-total" className="text-kpi font-semibold tabular-nums">{usd(p.spend.totalMicroUsd)}</span> <span className="text-muted">spent so far{p.spend.heldMicroUsd > 0 ? `, ${usd(p.spend.heldMicroUsd)} held for calls still open` : ""}</span></p>
          {p.costPlanTotalMicroUsd === null ? <Empty>No cost plan yet. The build step writes it.</Empty> : (
            <div className="flex min-w-0 flex-col gap-1">
              <H>Cost plan</H>
              <p className="m-0 text-body text-muted">Most this video can spend on paid generation: <span className="tabular-nums">{usd(p.costPlanTotalMicroUsd)}</span></p>
              {items.length === 0 ? <p className="m-0 text-body text-muted">No paid items: everything is free.</p> : <ul className="m-0 flex list-none flex-col gap-1 p-0 text-body">{items.map((it, i) => <li key={i} className="flex justify-between gap-4"><span>{String(it.kind)} from {String(it.provider)}</span><span className="tabular-nums text-muted">{usd(Number(it.quoteMicroUsd) || 0)}</span></li>)}</ul>}
            </div>
          )}
          <H>Spend by step</H>
          {p.spend.rows.length === 0 ? <p className="m-0 text-body text-muted">Nothing has been spent on this video.</p> : (
            <ul className="m-0 flex list-none flex-col gap-1 p-0 text-body">{p.spend.rows.map((r) => <li key={r.stage} className="flex justify-between gap-4"><span>{STAGE_LABELS[r.stage as StageName] ?? r.stage}</span><span className="tabular-nums text-muted">{usd(r.spentMicroUsd)}</span></li>)}</ul>
          )}
        </>
      );
    }
    case "qa": {
      if (!p.qa) return <Empty>No quality check yet. It runs after the video is rendered.</Empty>;
      return (
        <>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {p.qa.findings.map((f) => (
              <li key={f.id} className="flex min-w-0 flex-wrap items-baseline gap-2 text-body"><Pill tone={SEVERITY_WORDS[f.severity].tone}>{SEVERITY_WORDS[f.severity].label}</Pill><span className="min-w-0 [overflow-wrap:anywhere]">{f.text}</span></li>
            ))}
            {p.qa.findings.length === 0 ? <li className="text-body text-muted">The check recorded no findings.</li> : null}
          </ul>
          {p.qa.stills.length > 0 ? (
            <ul className="m-0 flex list-none flex-wrap gap-3 p-0">
              {p.qa.stills.map((src, i) => <li key={i}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={src} alt={`Review still ${i + 1}`} width={108} height={192} loading="lazy" className="h-48 w-auto rounded-card bg-raised" /></li>)}
            </ul>
          ) : <p className="m-0 text-body text-muted">No review stills are available.</p>}
        </>
      );
    }
    case "audit":
      return p.audit.length === 0 ? <Empty>Nothing in the audit log for this video yet.</Empty> : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {p.audit.map((a) => {
            const d = describeDetail(a.detail);
            return (
              <li key={a.id} className="flex min-w-0 flex-col gap-1 text-body">
                <span><code className="font-mono text-small">{a.event}</code> <span className="text-small text-faint">{ageLabel(a.at)} ago</span></span>
                {d.pairs.length > 0 ? <span className="text-small text-muted [overflow-wrap:anywhere]">{d.pairs.map((x) => `${x.key}: ${x.value}`).join(" · ")}</span> : null}
              </li>
            );
          })}
        </ul>
      );
    case "log":
      return p.log.length === 0 ? <Empty>Nothing logged yet. Step logs show up here while the video is being made.</Empty> : <LogTail lines={p.log} max={100} />;
  }
}

function BeatList({ beats }: { beats: unknown[] }) {
  return (
    <ol data-testid="beat-list" className="m-0 flex list-none flex-col gap-2 p-0">
      {beats.map((raw, i) => {
        const b = asObj(raw);
        const timing = ["start", "end", "duration_s", "duration"].filter((k) => typeof b[k] === "number").map((k) => `${k.replace("_s", "")} ${b[k]}s`).join(", ");
        return (
          <li key={i} className="flex min-w-0 flex-col gap-0.5 text-body">
            <span><code className="font-mono text-small">{typeof b.id === "string" ? b.id : `beat-${i + 1}`}</code>{timing ? <span className="text-small text-faint"> · {timing}</span> : null}</span>
            {typeof b.text === "string" ? <span className="text-muted [overflow-wrap:anywhere]">{b.text}</span> : null}
          </li>
        );
      })}
    </ol>
  );
}
