import Link from "next/link";
import { buildBeatRows } from "@/server/core/beat-rows";
import { BeatTable } from "@/ui/domain/beat-table";
import { Suspense } from "react";
import { z } from "zod";
import { requireOwner } from "@/lib/auth/require-owner";
import { describeDetail } from "@/server/core/audit-view";
import { microToUsd } from "@/server/core/llm-catalog";
import { ttsRerunProblem, type StageName } from "@/server/core/pipeline-plan";
import { renderLimitNote, scale3dSummary } from "@/server/core/scale3d-view";
import { lookView, scene3dSummary } from "@/server/core/scene3d-view";
import { loadRepoCatalog } from "@/server/providers/renderer/scene3d-models";
import { scriptSchema } from "@/server/core/script-contract";
import { estimateLabel, parseTab, forceRerunOffered, voiceChanged, rerunCostNote, rerunOffered, SEVERITY_WORDS, STAGE_LABELS, STATE_WORDS, TABS, type StageView, type TabId, type UiState } from "@/server/core/video-page-view";
import { FORMAT_WORDS, KIND_WORDS, LANGUAGE_WORDS, STATUS_WORDS } from "@/server/core/videos-view";
import { getPool } from "@/server/db/pool";
import { jobCheckers } from "../../queue/job-checkers";
import { loadQueue, mediaSigner } from "@/server/db/queue-data";
import { loadInrRate } from "@/server/db/system-settings";
import { loadVideoPage, type VideoPage } from "@/server/db/video-page";
import { loadPreview } from "@/server/db/video-preview";
import type { PreviewData } from "@/shared/preview";
import { presetOf } from "../../../../../remotion/kit/presets";
import { LazyPreviewStage } from "@/ui/kit/kit-lazy";
import { Button } from "@/ui/primitives/button";
import { ageLabel, GateCard, LookStills } from "../../queue/gate-card";
import { DecisionCard } from "../../queue/decision-card";
import { CancelForm } from "../../queue/forms";
import { LiveFeed } from "../../queue/live-feed";
import { LogTail } from "@/ui/domain/log-tail";
import { VideoBox } from "@/ui/domain/video-box";
import { Pill } from "@/ui/primitives/pill";
import { Skeleton } from "@/ui/primitives/skeleton";
import { ForceRerunForm, ReframeButtons, RerunForm, SaveToLibraryForm, SceneButtons } from "./controls";
import { SoundTabPanel } from "./sound-tab";
import { EvidenceTabPanel } from "./evidence-tab";
import { TitlesTabPanel } from "./titles-tab";

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
  const preview = tab === "preview" && p.head.kind !== "tsx" && p.head.kind !== "scene3d" && p.head.kind !== "scene3d_code" ? await loadPreview(db, id.data) : null; // read only; only this tab pays for it

  return (
    <div className="flex min-w-0 flex-col gap-layout">
      <header className="flex min-w-0 flex-col gap-3">
        <Link href="/videos" className="text-small text-muted underline">Library</Link>
        <h1 lang={p.head.language} className="m-0 text-page-title font-semibold tracking-tight [overflow-wrap:anywhere]">{p.head.topic}</h1>
        <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-body text-muted">
          <Pill tone={status.tone}>{status.label}</Pill>
          <span>{LANGUAGE_WORDS[p.head.language]}</span>
          <span data-testid="video-kind">Type: {KIND_WORDS[p.head.kind]}, {FORMAT_WORDS[p.head.format].toLowerCase()}</span>
          <span data-testid="video-style">Style: {presetOf(p.head.style).label}{p.head.captionStyle ? ", punchy captions" : ""}</span>
          <span data-testid="total-spend" className="tabular-nums">{usd(p.spend.totalMicroUsd)} spent</span>
          <span>Started {dt.format(new Date(p.head.createdAt))} UTC</span>
        </p>
      </header>

      {p.kindNote ? <p data-testid="kind-note" className="m-0 max-w-[68ch] rounded-card bg-surface p-pad text-body text-muted">{p.kindNote}</p> : null}
      {p.frameReviewNote ? <p data-testid="frame-review-note" className={`m-0 max-w-[68ch] rounded-card bg-surface p-pad text-body ${p.frameReviewNote.warn ? "text-warning" : "text-muted"}`}>{p.frameReviewNote.text}</p> : null}
      <LiveFeed />
      <StageStrip p={p} live={live} />

      {card ? card.kind === "gate" ? <GateCard item={card} index={0} rate={await loadInrRate(db)} /> : <DecisionCard item={card} /> : null}
      {live && !card ? <CancelForm videoId={p.head.id} topic={p.head.topic} /> : null}

      {p.videoSrc ? (
        <VideoBox aspect="9:16" label="Final video">
          <video controls preload="metadata" src={p.videoSrc} poster={p.posterSrc ?? undefined} aria-label="Final video" className="size-full object-contain" />
        </VideoBox>
      ) : null}
      {p.tsxLibrary && p.head.status !== "cancelled" ? <SaveToLibraryForm videoId={p.head.id} hash={p.tsxLibrary.hash} approved={p.tsxLibrary.approved} /> : null}
      {p.videoSrc && p.head.status !== "cancelled" ? <ReframeButtons videoId={p.head.id} links={p.reframed} /> : null}

      <nav aria-label="Video sections" className="flex min-w-0 gap-5 overflow-x-auto border-b border-rule">
        {TABS.map((t) => (
          <Link key={t.id} href={`/videos/${p.head.id}?tab=${t.id}`} scroll={false} aria-current={tab === t.id ? "page" : undefined} className="-mb-px inline-flex min-h-11 items-center border-b-2 border-transparent text-body text-muted aria-[current=page]:border-text aria-[current=page]:text-text sm:min-h-9">
            {t.label}
          </Link>
        ))}
      </nav>
      <section aria-label={TABS.find((t) => t.id === tab)!.label} data-testid="tab-panel" data-tab={tab} className="flex min-w-0 flex-col gap-4">
        <Panel tab={tab} p={p} preview={preview} />
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
  const anyActive = Object.values(p.runStatus).some((r) => r === "queued" || r === "running" || r === "needs_decision");
  return (
    <section aria-label="Steps" className="flex min-w-0 flex-col gap-3 rounded-card bg-surface p-pad">
      <ol data-testid="stage-strip" className="m-0 grid list-none gap-3 p-0 sm:grid-cols-2">
        {p.stages.map((s: StageView) => {
          const force = forceRerunOffered(s.stage as StageName, p.runStatus[s.stage as StageName], p.head.status, anyActive, p.hasUpload, p.voice.current?.provider ?? null, p.voice.localUrl);
          const isTts = s.stage === "tts";
          const paidVoice = isTts && p.runStatus.tts === "succeeded" && !anyActive && !p.hasUpload ? ttsRerunProblem(p.voice.current?.provider, p.voice.localUrl) : null;
          const again = rerunOffered(p.runStatus[s.stage as StageName], p.head.status);
          return (
            <li key={s.stage} id={`stage-${s.stage}`} data-stage={s.stage} data-state={s.state} className="flex min-w-0 flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-body font-medium">{s.label}</span>
                <Pill tone={STATE_TONE[s.state]}>{STATE_WORDS[s.state]}</Pill>
              </div>
              <p className="m-0 text-small text-muted [overflow-wrap:anywhere]">{s.detail}{s.timeLeft ? ` · ${s.timeLeft}` : ""}</p>
              {isTts && p.voice.stored ? <p data-testid="narration-voice" className="m-0 text-small text-muted [overflow-wrap:anywhere]">Voice: {p.voice.stored.provider} / {p.voice.stored.voice}</p> : null}
              {s.state === "running" && s.percent !== null ? <progress value={s.percent} max={100} aria-label={`${s.label} progress`} className="h-1 w-full" /> : null}
              {live && again ? <RerunForm videoId={p.head.id} stage={s.stage} label={STAGE_LABELS[s.stage as StageName]} estimate={estimateLabel(p.estimates[s.stage as StageName] ?? null)} costNote={rerunCostNote(s.stage as StageName, p.costPlanTotalMicroUsd)} /> : null}
              {live && paidVoice ? <p data-testid="paid-voice" className="m-0 text-small text-muted">{paidVoice}</p> : null}
              {live && force ? <ForceRerunForm videoId={p.head.id} stage={s.stage} label={STAGE_LABELS[s.stage as StageName]} {...(isTts && { hint: "Narration, picture render, mix and check run again.", changed: voiceChanged(p.voice.stored, p.voice.current) })} /> : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

const Empty = ({ children }: { children: React.ReactNode }) => <p data-testid="empty" className="m-0 max-w-[60ch] rounded-card bg-surface p-pad text-body text-muted">{children}</p>;
const H = ({ children }: { children: React.ReactNode }) => <h2 className="m-0 text-title font-semibold">{children}</h2>;

function Scale3dPreview({ p }: { p: VideoPage }) {
  const rendered = p.stages.some((s) => s.stage === "render" && s.state === "done");
  const limit = renderLimitNote(p.renderTimeoutS);
  if (!p.scale3dBody) return <Empty>No 3D scene yet. It appears once the build step has made it.</Empty>;
  const v = scale3dSummary(p.scale3dBody);
  if (!v.ok) return <Empty>{v.message}</Empty>;
  const { beats, objects, totalS, loop } = v.summary;
  const th = "px-2 py-2 text-small font-normal text-faint first:pl-0";
  const td = "px-2 py-3 align-top first:pl-0 [overflow-wrap:anywhere]";
  return (
    <>
      <p data-testid="preview-note" className="m-0 max-w-[68ch] text-body text-muted">A 3D scale video has no live preview: this is its plan, in order. {rendered ? "The final video is on the Review step." : "The final video is made by Render."}</p>
      {limit ? <p role="note" data-testid="render-limit-note" className="m-0 max-w-[68ch] rounded-card bg-pill-warning-bg p-4 text-body text-pill-warning-ink">{limit}</p> : null}
      <p className="m-0 text-body tabular-nums">Total length {totalS} s. Loops back to the start: {loop ? "yes" : "no"}.</p>
      <H>Beats</H>
      <div className="min-w-0 overflow-x-auto">
        <table className="w-full border-collapse text-left text-body">
          <caption className="sr-only">Beats of the 3D scale video, in order</caption>
          <thead><tr className="border-b border-rule"><th scope="col" className={th}>#</th><th scope="col" className={th}>Starts (s)</th><th scope="col" className={th}>Length (s)</th><th scope="col" className={th}>On screen and spoken</th><th scope="col" className={th}>Focus</th><th scope="col" className={th}>Ruler range</th></tr></thead>
          <tbody>
            {beats.map((b) => (
              <tr key={b.n} className="border-b border-rule">
                <td className={`${td} tabular-nums`}>{b.n}</td><td className={`${td} tabular-nums`}>{b.startS}</td><td className={`${td} tabular-nums`}>{b.durationS}</td>
                <td className={td}><span className="font-medium">{b.label}</span><span className="block text-muted">{b.caption}</span></td>
                <td className={td}>{b.focus}</td><td className={`${td} tabular-nums`}>{b.rangeLabel}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <H>Objects and heights</H>
      <div className="min-w-0 overflow-x-auto">
        <table className="w-full border-collapse text-left text-body">
          <caption className="sr-only">Objects, real heights and how each height is backed</caption>
          <thead><tr className="border-b border-rule"><th scope="col" className={th}>Object</th><th scope="col" className={th}>Height (m)</th><th scope="col" className={th}>How it is backed</th><th scope="col" className={th}>Source or method</th></tr></thead>
          <tbody>
            {objects.map((o) => (
              <tr key={o.id} className="border-b border-rule">
                <td className={td}>{o.label}<span className="block text-small text-muted">{o.kindWord}</span></td><td className={`${td} tabular-nums`}>{o.heightM}</td>
                <td className={td}>{o.claimKind === "sourced" ? "Sourced" : "Calculated"}</td><td className={`${td} text-muted`}>{o.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** A 3D story has no live preview: the storyboard (shots with times and visual lines), what is in the scene, what was not found, and the preview pictures once they exist. */
async function Scene3dPreview({ p }: { p: VideoPage }) {
  const d = p.scene3d;
  const catalog = await loadRepoCatalog(process.cwd()).catch(() => null); // names only; without the catalogue the ids are shown
  const v = scene3dSummary(d?.scenes ?? null, d?.story ?? null, (id) => catalog?.getById(id)?.name ?? null);
  if (!v.ok) return <Empty>{v.message}</Empty>;
  const { shots, objects, missing, totalS } = v.summary;
  const look = lookView(d?.previews ?? null, d?.scenes ?? null);
  const sign = look.ok ? await mediaSigner(getPool()) : null;
  const rendered = p.stages.some((s) => s.stage === "render" && s.state === "done");
  const th = "px-2 py-2 text-small font-normal text-faint first:pl-0";
  const td = "px-2 py-3 align-top first:pl-0 [overflow-wrap:anywhere]";
  return (
    <>
      <p data-testid="preview-note" className="m-0 max-w-[68ch] text-body text-muted">A 3D story has no live preview: this is its plan, in order, and the preview pictures once they are drawn. {rendered ? "The final video is on the Review step." : "The final video is made by Render after you approve the look."}</p>
      <p data-testid="scene3d-total" className="m-0 text-body tabular-nums">Total length {totalS} s, {shots.length} shots. The times are the director&apos;s plan; they are fitted to the narration when the preview pictures are drawn.</p>
      <H>Storyboard</H>
      <div className="min-w-0 overflow-x-auto">
        <table data-testid="scene3d-shots" className="w-full border-collapse text-left text-body">
          <caption className="sr-only">Shots of the 3D story, in order</caption>
          <thead><tr className="border-b border-rule"><th scope="col" className={th}>#</th><th scope="col" className={th}>Starts (s)</th><th scope="col" className={th}>Length (s)</th><th scope="col" className={th}>What we see</th><th scope="col" className={th}>Camera on</th></tr></thead>
          <tbody>
            {shots.map((s) => (
              <tr key={s.n} className="border-b border-rule">
                <td className={`${td} tabular-nums`}>{s.n}</td><td className={`${td} tabular-nums`}>{s.startS}</td><td className={`${td} tabular-nums`}>{s.durationS}</td>
                <td className={td}><span className="font-medium">{s.beat ?? s.id}</span>{s.visual ? <span className="block text-muted">{s.visual}</span> : null}{s.caption ? <span className="block text-small text-muted">Caption: {s.caption}</span> : null}</td>
                <td className={td}>{s.focus}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <H>In the scene</H>
      <ul data-testid="scene3d-objects" className="m-0 flex list-none flex-col gap-1 p-0 text-body">
        {objects.map((o) => <li key={o.id} className="[overflow-wrap:anywhere]">{o.id}: {o.label}</li>)}
      </ul>
      <H>What could not be found</H>
      {missing.length === 0 ? (
        <p data-testid="scene3d-missing" className="m-0 text-body text-muted">Every visual was matched to a model or a block.</p>
      ) : (
        <ul data-testid="scene3d-missing" className="m-0 flex list-none flex-col gap-1 p-0 text-body">
          {missing.map((m, i) => <li key={i} className="[overflow-wrap:anywhere]">Scene {m.beat}: wanted {m.wanted}; used {m.substitute} instead.</li>)}
        </ul>
      )}
      <H>Preview pictures</H>
      {look.ok ? <LookStills stills={look.look.stills.map((s) => ({ ...s, src: sign ? sign(`videos/${p.head.id}/${s.file}`) : null }))} /> : <Empty>No preview pictures yet. They are drawn after the narration is made.</Empty>}
    </>
  );
}

/** A 3D story written as code has no storyboard table: the models it uses and the preview pictures once they exist. */
async function Scene3dCodePreview({ p }: { p: VideoPage }) {
  const d = p.scene3d;
  const catalog = await loadRepoCatalog(process.cwd()).catch(() => null);
  const body = typeof d?.scenes === "object" && d.scenes !== null ? (d.scenes as { models?: unknown }) : {};
  const ids = Array.isArray(body.models) ? body.models.filter((m): m is string => typeof m === "string").slice(0, 60) : [];
  const look = lookView(d?.previews ?? null, d?.scenes ?? null);
  const sign = look.ok ? await mediaSigner(getPool()) : null;
  return (
    <>
      <p data-testid="preview-note" className="m-0 max-w-[68ch] text-body text-muted">The AI wrote this scene as code. It has no live preview: the preview pictures appear after the narration is made, and the long render runs only after you approve the look.</p>
      <H>Models used</H>
      {ids.length === 0 ? <Empty>No scene yet. It appears once the author step has written it.</Empty> : (
        <ul data-testid="scene3d-objects" className="m-0 flex list-none flex-col gap-1 p-0 text-body">
          {ids.map((id) => <li key={id} className="[overflow-wrap:anywhere]">{catalog?.getById(id)?.name ?? id}</li>)}
        </ul>
      )}
      <H>Preview pictures</H>
      {look.ok ? <LookStills stills={look.look.stills.map((s) => ({ ...s, src: sign ? sign(`videos/${p.head.id}/${s.file}`) : null }))} /> : <Empty>No preview pictures yet. They are drawn after the narration is made.</Empty>}
    </>
  );
}

function Panel({ tab, p, preview }: { tab: TabId; p: VideoPage; preview: PreviewData | null }) {
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
              <BeatTable rows={buildBeatRows(s.data.beats)} shownForReal={s.data.shown_for_real} style={p.head.style} />
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
    case "preview":
      if (p.head.kind === "tsx") return <Empty>Preview is not available for custom animation; use the final render.</Empty>;
      if (p.head.kind === "scale3d") return <Scale3dPreview p={p} />;
      if (p.head.kind === "scene3d") return <Scene3dPreview p={p} />;
      if (p.head.kind === "scene3d_code") return <Scene3dCodePreview p={p} />;
      return !preview ? <Empty>No scenes yet. The preview appears once the build step has made them.</Empty> : (
        <>
          <p data-testid="preview-note" className="m-0 max-w-[68ch] text-body text-muted">Preview only. The final video is made by Render.</p>
          <LazyPreviewStage data={preview} videoId={p.head.id} title={p.head.topic} style={p.head.style} captionStyle={p.head.captionStyle} />
          <div><Button asChild variant="secondary"><a href="#stage-render">Go to the Render step</a></Button></div>
        </>
      );
    case "evidence":
      return <EvidenceTabPanel p={p} />;
    case "titles":
      return <TitlesTabPanel p={p} />;
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
    case "sound":
      return <SoundTabPanel p={p} />;
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
            {typeof b.visual === "string" && b.visual ? <span className="text-small text-faint [overflow-wrap:anywhere]">Picture: {b.visual}</span> : null}
          </li>
        );
      })}
    </ol>
  );
}
