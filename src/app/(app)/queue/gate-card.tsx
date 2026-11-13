import { formatMoney } from "@/server/core/display-format";
import { microToUsd } from "@/server/core/llm-catalog";
import type { GateClaim, GateContent, GateItem } from "@/server/db/queue-data";
import { ChannelInitial } from "@/ui/domain/channel-initial";
import { BeatTable } from "@/ui/domain/beat-table";
import { CutStrip } from "@/ui/domain/cut-strip";
import { cutStages } from "@/ui/domain/queue-strip";
import { aspectFor } from "@/ui/domain/stages";
import { Pill } from "@/ui/primitives/pill";
import { clock } from "@/server/core/long-form";
import { CancelForm, GateForms, OutlineEditForm, PublishChoiceForm, type GateFields } from "./forms";

const GATE_LABEL: Record<GateItem["gate"], { name: string; ask: string; approve: string }> = {
  outline: { name: "Outline", ask: "Read the chapters. Approving lets the studio write the script from exactly this outline. Nothing is spent on narration yet.", approve: "Approve outline" },
  script: { name: "Script", ask: "Read the script. Approving lets the studio build the video from exactly this text.", approve: "Approve script" },
  cost: { name: "Cost", ask: "Approving lets the studio spend up to the total below on paid images and clips. It will not spend more.", approve: "Approve cost" },
  video: { name: "Video", ask: "Watch the video. Approving says this exact file is the one you reviewed.", approve: "Approve video" },
  evidence: { name: "Evidence", ask: "Check that every claim has a source you trust. Approving signs the evidence off.", approve: "Approve evidence" },
  publish: { name: "Publish", ask: "Approving sends exactly this video, with this title, visibility and schedule, to YouTube. It happens once.", approve: "Approve and publish" },
};

const money = (micro: number) => `$${microToUsd(micro)}`;
const dt = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
/** UTC instant -> the value a datetime-local box wants, in India time. */
const istInput = (iso: string | null): string => (iso ? new Date(Date.parse(iso) + 5.5 * 3600_000).toISOString().slice(0, 16) : "");
const VIS: Record<string, string> = { private: "Private", unlisted: "Unlisted", public: "Public" };
const kidsWord = (m: boolean | null) => (m === null ? "with no made-for-kids answer saved yet" : m ? "and marks it MADE FOR KIDS" : "and marks it NOT made for kids");

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

function Player({ src, label, long = false }: { src: string | null; label: string; long?: boolean }) {
  if (!src) return <p className="m-0 text-body text-muted">The video player is not available right now (the media key is locked or the file has no path). Reload, or check Settings, Keys.</p>;
  return <video controls preload="metadata" src={src} aria-label={label} className={long ? "aspect-video max-h-[520px] w-auto max-w-full rounded-card bg-raised" : "aspect-[9/16] max-h-[520px] w-auto max-w-full rounded-card bg-raised"} />;
}

/** The outline of a long video: chapters with their estimated length and narration words, the total, and the form to edit them. */
function OutlineContent({ c, lang, fields }: { c: Extract<GateContent, { kind: "outline" }>; lang: string; fields: GateFields }) {
  if (!c.outline) return <p data-testid="outline-unreadable" className="m-0 max-w-[68ch] text-body text-muted">This outline could not be read in its usual shape. Send it back with a note and a new one will be written.</p>;
  const o = c.outline;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <p data-testid="outline-total" className="m-0 text-small text-muted tabular-nums">
        {o.chapters.length} chapters, about {clock(o.totalS)} ({Math.round(o.totalS / 60)} min) of narration, roughly {o.words} spoken words. You asked for {o.minMinutes} to {o.maxMinutes} minutes.
      </p>
      <ol data-testid="outline-chapters" className="m-0 flex list-none flex-col gap-3 p-0">
        {o.chapters.map((ch, i) => (
          <li key={i} className="flex min-w-0 flex-col gap-1 rounded-card bg-raised p-3">
            <span lang={lang} className="text-section font-medium [overflow-wrap:anywhere]">{i + 1}. {ch.title}</span>
            <span lang={lang} className="max-w-[68ch] text-body text-muted [overflow-wrap:anywhere]">{ch.line}</span>
            <span className="text-small text-muted tabular-nums">About {clock(ch.targetS)} ({ch.targetS} s), roughly {ch.words} words</span>
          </li>
        ))}
      </ol>
      <p role="note" data-testid="outline-cost-note" className="m-0 max-w-[68ch] text-small text-muted">The voice cost depends on the voice you picked and is shown at the cost step, before any narration is paid for. Approving this outline spends nothing by itself.</p>
      <OutlineEditForm fields={{ videoId: fields.videoId, seenHash: fields.seenHash, seenVersions: fields.seenVersions }} chapters={o.chapters} />
    </div>
  );
}

function Content({ c, lang, videoId, rate, long, fields }: { c: GateContent; lang: string; videoId: string; rate: number; long: boolean; fields: GateFields }) {
  switch (c.kind) {
    case "outline":
      return <OutlineContent c={c} lang={lang} fields={fields} />;
    case "script":
      return (
        <div className="flex min-w-0 flex-col gap-3">
          <p lang={lang} className="m-0 text-section font-medium [overflow-wrap:anywhere]">{c.title}</p>
          <p className="m-0 text-small text-muted tabular-nums">{c.readable ? `${c.words} words, ${c.beats} scenes` : "This script could not be read in the usual shape; the raw text is shown."}</p>
          <p lang={lang} data-testid="script-text" className="m-0 max-w-[68ch] whitespace-pre-wrap text-body [overflow-wrap:anywhere]">{c.narration}</p>
          {c.description ? <p className="m-0 max-w-[68ch] text-body text-muted [overflow-wrap:anywhere]">{c.description}</p> : null}
          <BeatTable rows={c.beatRows} shownForReal={c.shownForReal} style={c.style} />
          <h4 className="m-0 mt-2 text-small font-medium text-muted">Evidence</h4>
          <Claims claims={c.claims} />
        </div>
      );
    case "cost":
      return (
        <div className="flex min-w-0 flex-col gap-3">
          <p className="m-0 flex flex-wrap items-baseline gap-3"><span data-testid="cost-total" className="text-kpi font-semibold tabular-nums">{money(c.totalMicroUsd)}</span><span data-testid="cost-inr" className="text-body text-muted tabular-nums">{formatMoney(c.totalMicroUsd, rate).replace(/^\S+ /, "")}</span><span className="text-body text-muted">most this video can spend on paid generation</span></p>
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
          {c.shots && c.shots.length > 0 ? (
            <div className="flex flex-col gap-1">
              <h4 className="m-0 mt-2 text-small font-medium text-muted">What each clip asks for{c.character ? " (every clip starts from your character picture)" : ""}</h4>
              <ol data-testid="cost-shots" className="m-0 flex list-none flex-col gap-1 p-0 text-body">
                {c.shots.map((x) => (
                  <li key={x.beatId} className="[overflow-wrap:anywhere]"><span className="text-muted tabular-nums">{x.seconds} s</span> {x.prompt}</li>
                ))}
              </ol>
            </div>
          ) : null}
        </div>
      );
    case "video":
      return (
        <div className="flex min-w-0 flex-col gap-2">
          <Player src={c.src} label="Video to review" long={long} />
          {c.captions === "approximate" ? <p role="note" data-testid="captions-note" className="m-0 max-w-[68ch] rounded-card bg-pill-warning-bg p-4 text-body text-pill-warning-ink">Captions approximate: listen and check</p> : null}
          {c.rewriteLines.length > 0 ? <p role="note" data-testid="rewrite-note" className="m-0 max-w-[68ch] rounded-card bg-pill-warning-bg p-4 text-body text-pill-warning-ink">{c.rewriteLines.length === 1 ? "One line is" : `${c.rewriteLines.length} lines are`} too long for the video even sped up: send this back and rewrite line{c.rewriteLines.length === 1 ? "" : "s"} {c.rewriteLines.map((n) => n + 1).join(", ")} shorter.</p> : null}
          {c.captions === "check" && c.rewriteLines.length === 0 ? <p role="note" data-testid="captions-note" className="m-0 max-w-[68ch] text-body text-muted">Some caption words are guesses: listen and check.</p> : null}
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
            <dt className="text-muted">Made for kids</dt><dd data-testid="publish-kids" className="m-0">{c.madeForKids === null ? "Not saved yet (Titles tab)" : c.madeForKids ? "Yes" : "No"}</dd>
            <dt className="text-muted">Visibility</dt><dd data-testid="publish-visibility" className="m-0 capitalize">{c.visibility}</dd>
            <dt className="text-muted">Goes live</dt><dd className="m-0">{c.publishAt ? `${dt.format(new Date(c.publishAt))} IST` : "As soon as the upload finishes"}</dd>
          </dl>
          {c.description ? <p className="m-0 max-w-[68ch] text-body text-muted [overflow-wrap:anywhere]">{c.description}</p> : null}
          <PublishChoiceForm videoId={videoId} visibility={c.visibility} publishAtIst={istInput(c.publishAt)} channelId={c.channel} channels={c.channels} publicOpen={c.publicOpen} />
          <Player src={c.videoSrc} label="Video to publish" long={long} />
          <p className="m-0 text-small text-faint">Evidence file fingerprint {c.evidenceShaPrefix}</p>
        </div>
      );
  }
}

export function GateCard({ item, index, rate }: { item: GateItem; index: number; rate: number }) {
  const g = GATE_LABEL[item.gate];
  const sentBack = item.sentBackNote !== null;
  return (
    <article aria-label={`${g.name} gate: ${item.topic}`} data-testid="gate-card" data-gate={item.gate} data-video={item.videoId} className="flex min-w-0 flex-col gap-5 rounded-card border border-border bg-surface p-pad">
      <header className="flex min-w-0 flex-col gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Pill tone="warning">{g.name} gate</Pill>
          {item.channelId ? (
            <span className="inline-flex min-w-0 items-center gap-2 text-small text-muted"><ChannelInitial name={item.channelId} index={index} className="size-5" /><span className="[overflow-wrap:anywhere]">{item.channelId}</span></span>
          ) : null}
          <span className="text-small text-faint">waiting {ageLabel(item.waitingSince)}</span>
        </div>
        <h2 lang={item.language} className="m-0 min-w-0 text-title font-semibold leading-tight [overflow-wrap:anywhere]">{item.topic}</h2>
        <CutStrip format={item.format} aspect={aspectFor(item.format)} stages={cutStages(item.strip, item.format)} thumbnail={false} layout="stack" />
      </header>
      <p data-testid="gate-ask" className="m-0 max-w-[68ch] text-body text-muted">
        {item.content.kind === "publish"
          ? `Approving sends exactly this video to ${item.content.channelTitle ?? (item.content.channel || "no channel chosen")} as ${VIS[item.content.visibility] ?? "(not chosen)"}, ${kidsWord(item.content.madeForKids)}. It happens once.`
          : g.ask}
      </p>
      <Content c={item.content} lang={item.language} videoId={item.videoId} rate={rate} long={item.format === "long"} fields={{ videoId: item.videoId, gate: item.gate, seenHash: item.hash, seenVersions: item.versions }} />
      {sentBack ? (
        <p role="note" className="m-0 max-w-[68ch] rounded-card bg-pill-warning-bg p-4 text-body text-pill-warning-ink">You sent this back: &ldquo;{item.sentBackNote}&rdquo;. It stays on hold until the new version arrives.</p>
      ) : null}
      {item.blocked !== undefined ? (
        <p data-testid="gate-blocked" className="m-0 max-w-[68ch] text-body text-muted">
          Not ready to approve yet: {item.blocked}. Use the form above (and the Titles tab if details are missing), then reload this page.
        </p>
      ) : (
        <>
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
        </>
      )}
      <CancelForm videoId={item.videoId} topic={item.topic} />
    </article>
  );
}
