import { microToUsd } from "@/server/core/llm-catalog";
import type { GateClaim, GateContent, GateItem } from "@/server/db/queue-data";
import { ChannelInitial } from "@/ui/domain/channel-initial";
import { CutStrip } from "@/ui/domain/cut-strip";
import { cutStages } from "@/ui/domain/queue-strip";
import { Pill } from "@/ui/primitives/pill";
import { CancelForm, GateForms } from "./forms";

const GATE_LABEL: Record<GateItem["gate"], { name: string; ask: string; approve: string }> = {
  script: { name: "Script", ask: "Read the script. Approving lets the studio build the video from exactly this text.", approve: "Approve script" },
  cost: { name: "Cost", ask: "Approving lets the studio spend up to the total below on paid images and clips. It will not spend more.", approve: "Approve cost" },
  video: { name: "Video", ask: "Watch the video. Approving says this exact file is the one you reviewed.", approve: "Approve video" },
  evidence: { name: "Evidence", ask: "Check that every claim has a source you trust. Approving signs the evidence off.", approve: "Approve evidence" },
  publish: { name: "Publish", ask: "Approving sends exactly this video, with this title, visibility and schedule, to YouTube. It happens once.", approve: "Approve and publish" },
};

const money = (micro: number) => `$${microToUsd(micro)}`;
const dt = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

export function ageLabel(iso: string, now = Date.now()): string {
  const min = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min} min`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h`;
  return `${Math.round(min / 1440)} days`;
}

function Claims({ claims }: { claims: GateClaim[] }) {
  if (claims.length === 0) return <p className="m-0 text-body text-muted">This script lists no claims.</p>;
  return (
    <div className="min-w-0 overflow-x-auto">
      <table className="w-full border-collapse text-left text-body">
        <caption className="sr-only">Claims and where they come from</caption>
        <thead>
          <tr className="border-b border-rule">
            <th scope="col" className="px-2 py-2 text-small font-normal text-faint first:pl-0">Claim</th>
            <th scope="col" className="px-2 py-2 text-small font-normal text-faint">How it is backed</th>
            <th scope="col" className="px-2 py-2 text-small font-normal text-faint">Source or method</th>
          </tr>
        </thead>
        <tbody>
          {claims.map((c, i) => (
            <tr key={i} className="border-b border-rule align-top">
              <td className="px-2 py-3 first:pl-0 [overflow-wrap:anywhere]">{c.text}</td>
              <td className="px-2 py-3">{c.kind === "sourced" ? "Sourced" : "Calculated"}</td>
              <td className="px-2 py-3 text-muted [overflow-wrap:anywhere]">{c.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Player({ src, label }: { src: string | null; label: string }) {
  if (!src) return <p className="m-0 text-body text-muted">The video player is not available right now (the media key is locked or the file has no path). Reload, or check Settings, Keys.</p>;
  return <video controls preload="metadata" src={src} aria-label={label} className="aspect-[9/16] max-h-[520px] w-auto max-w-full rounded-card bg-raised" />;
}

function Content({ c, lang }: { c: GateContent; lang: string }) {
  switch (c.kind) {
    case "script":
      return (
        <div className="flex min-w-0 flex-col gap-3">
          <p lang={lang} className="m-0 text-section font-medium [overflow-wrap:anywhere]">{c.title}</p>
          <p className="m-0 text-small text-muted tabular-nums">{c.readable ? `${c.words} words, ${c.beats} scenes` : "This script could not be read in the usual shape; the raw text is shown."}</p>
          <p lang={lang} data-testid="script-text" className="m-0 max-w-[68ch] whitespace-pre-wrap text-body [overflow-wrap:anywhere]">{c.narration}</p>
          {c.description ? <p className="m-0 max-w-[68ch] text-body text-muted [overflow-wrap:anywhere]">{c.description}</p> : null}
          <h4 className="m-0 mt-2 text-small font-medium text-muted">Evidence</h4>
          <Claims claims={c.claims} />
        </div>
      );
    case "cost":
      return (
        <div className="flex min-w-0 flex-col gap-3">
          <p className="m-0 flex flex-wrap items-baseline gap-3"><span data-testid="cost-total" className="text-kpi font-semibold tabular-nums">{money(c.totalMicroUsd)}</span><span className="text-body text-muted">most this video can spend on paid generation</span></p>
          <dl className="m-0 grid gap-x-6 gap-y-1 text-body sm:grid-cols-[max-content_1fr]">
            <dt className="text-muted">Way of making it</dt><dd className="m-0">{c.path}</dd>
            {c.models.map(([k, v]) => (
              <div key={k} className="contents"><dt className="text-muted">{k}</dt><dd className="m-0 [overflow-wrap:anywhere]">{v}</dd></div>
            ))}
          </dl>
          {c.items.length > 0 ? (
            <ul className="m-0 flex list-none flex-col gap-1 p-0 text-body">
              {c.items.map((it, i) => (
                <li key={i} className="flex justify-between gap-4"><span>{it.kind} from {it.provider}</span><span className="tabular-nums text-muted">{money(it.quoteMicroUsd)}</span></li>
              ))}
            </ul>
          ) : null}
        </div>
      );
    case "video":
      return (
        <div className="flex min-w-0 flex-col gap-2">
          <Player src={c.src} label="Video to review" />
          {c.captions === "approximate" ? <p role="note" data-testid="captions-note" className="m-0 max-w-[68ch] rounded-card bg-pill-warning-bg p-4 text-body text-pill-warning-ink">Captions approximate: listen and check</p> : null}
          {c.captions === "check" ? <p role="note" data-testid="captions-note" className="m-0 max-w-[68ch] text-body text-muted">Some caption words are guesses: listen and check.</p> : null}
          {c.captions === "checked" ? <p data-testid="captions-note" className="m-0 text-small text-muted">You checked the approximate captions.</p> : null}
          <p className="m-0 text-small text-faint">File fingerprint {c.shaPrefix}</p>
        </div>
      );
    case "evidence":
      return (
        <div className="flex min-w-0 flex-col gap-3">
          <Claims claims={c.claims} />
          <p className="m-0 text-small text-faint">
            Evidence file fingerprint {c.shaPrefix}
            {c.fileSrc ? <> · <a className="underline" href={c.fileSrc} target="_blank" rel="noreferrer">open the file</a></> : null}
          </p>
        </div>
      );
    case "publish":
      return (
        <div className="flex min-w-0 flex-col gap-3">
          <dl className="m-0 grid gap-x-6 gap-y-1 text-body sm:grid-cols-[max-content_1fr]">
            <dt className="text-muted">Title</dt><dd lang={lang} className="m-0 [overflow-wrap:anywhere]">{c.title}</dd>
            <dt className="text-muted">Channel</dt><dd data-testid="publish-channel" className="m-0 [overflow-wrap:anywhere]">{c.channel}</dd>
            <dt className="text-muted">Visibility</dt><dd data-testid="publish-visibility" className="m-0 capitalize">{c.visibility}</dd>
            <dt className="text-muted">Goes live</dt><dd className="m-0">{c.publishAt ? `${dt.format(new Date(c.publishAt))} UTC` : "As soon as the upload finishes"}</dd>
          </dl>
          {c.description ? <p className="m-0 max-w-[68ch] text-body text-muted [overflow-wrap:anywhere]">{c.description}</p> : null}
          <Player src={c.videoSrc} label="Video to publish" />
          <p className="m-0 text-small text-faint">Evidence file fingerprint {c.evidenceShaPrefix}</p>
        </div>
      );
  }
}

export function GateCard({ item, index }: { item: GateItem; index: number }) {
  const g = GATE_LABEL[item.gate];
  const sentBack = item.sentBackNote !== null;
  return (
    <article aria-label={`${g.name} gate: ${item.topic}`} data-testid="gate-card" data-gate={item.gate} data-video={item.videoId} className="flex min-w-0 flex-col gap-5 rounded-card bg-surface p-pad">
      <header className="flex min-w-0 flex-col gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Pill tone="warning">{g.name} gate</Pill>
          {item.channelId ? (
            <span className="inline-flex min-w-0 items-center gap-2 text-small text-muted"><ChannelInitial name={item.channelId} index={index} className="size-5" /><span className="[overflow-wrap:anywhere]">{item.channelId}</span></span>
          ) : null}
          <span className="text-small text-faint">waiting {ageLabel(item.waitingSince)}</span>
        </div>
        <h2 lang={item.language} className="m-0 min-w-0 text-title font-semibold leading-tight [overflow-wrap:anywhere]">{item.topic}</h2>
        <CutStrip format="short" aspect="9:16" stages={cutStages(item.strip)} thumbnail={false} layout="stack" />
      </header>
      <p className="m-0 max-w-[68ch] text-body text-muted">{g.ask}</p>
      <Content c={item.content} lang={item.language} />
      {sentBack ? (
        <p role="note" className="m-0 max-w-[68ch] rounded-card bg-pill-warning-bg p-4 text-body text-pill-warning-ink">You sent this back: &ldquo;{item.sentBackNote}&rdquo;. It stays on hold until the new version arrives.</p>
      ) : null}
      <p className="m-0 text-small text-faint">
        Review reference <code data-testid="review-ref" className="font-mono">{item.hash.slice(0, 12)}</code>. If anything changes after you opened this page, the buttons below will refuse and show the new version.
      </p>
      <GateForms
        fields={{ videoId: item.videoId, gate: item.gate, seenHash: item.hash, seenVersions: item.versions }}
        approveLabel={g.approve}
        canApprove={!sentBack}
        captionsTick={item.content.kind === "video" && item.content.captions === "approximate"}
        topic={item.topic}
      />
      <CancelForm videoId={item.videoId} topic={item.topic} />
    </article>
  );
}
