"use client";
// The only file that loads @remotion/player and the kit. It is reached through kit-lazy.tsx (dynamic import, client only),
// so no other page ships this code.
import { Player, type PlayerRef } from "@remotion/player";
import { useMemo, useRef, useState } from "react";
import { KitScene, KitVideo } from "./kit-bridge";
import { LOOKS } from "../../../remotion/kit/look";
import { theme } from "../../../remotion/kit/theme";
import { slideshowRisk } from "@/shared/scene/slideshow";
import { docFrames } from "../../../remotion/kit/timeline";
import { seedForLook, type PreviewData } from "@/shared/preview";
import { sampleDoc, SAMPLE_SCENES } from "@/shared/scene/samples";
import type { Scene } from "@/shared/scene";

// Stand-in for a picture that is not stored: a flat dark square.
const FALLBACK = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='1080' height='1920'><rect width='100%25' height='100%25' fill='%23222a3a'/></svg>";
const abs = (u: string | null) => (u && typeof location !== "undefined" ? new URL(u, location.origin).href : (u ?? undefined)); // Remotion's <Audio> wants a full URL
const fail = () => <div className="p-4 text-small text-white">This scene could not be drawn. Re-check the scenes.</div>;
const box = "flex flex-col gap-1";

export function PreviewStage({ data, videoId, title, style, captionStyle }: { data: PreviewData; videoId: string; title: string; style?: string | null; captionStyle?: string | null }) {
  const ref = useRef<PlayerRef>(null);
  const [look, setLook] = useState<number | null>(null);
  const [captions, setCaptions] = useState(true);
  const [safe, setSafe] = useState(false);
  const risks = useMemo(() => slideshowRisk(data.doc.scenes as unknown as Array<{ kind: string }>), [data]);
  const frames = docFrames(data.doc.scenes, data.fps);
  const props = useMemo(
    () => ({
      doc: data.doc, fps: data.fps, title, seed: look === null ? videoId : seedForLook(look), assets: data.assets,
      resolveAsset: (id: string) => data.assets[id] ?? FALLBACK,
      audioSrc: abs(data.audio.src), captions: captions ? (data.captions ?? undefined) : undefined,
      style: style ?? undefined, captionStyle: captionStyle ?? undefined,
    }),
    [data, title, videoId, look, captions, style, captionStyle],
  );
  return (
    <div className="flex min-w-0 flex-col gap-4 sm:flex-row">
      <div className="flex w-full max-w-[320px] shrink-0 flex-col gap-3">
        <div className="relative overflow-hidden rounded-card bg-surface" data-testid="preview-player">
          <Player ref={ref} component={KitVideo} inputProps={props} compositionWidth={theme.width} compositionHeight={theme.height} fps={data.fps} durationInFrames={Math.max(1, frames)}
            controls allowFullscreen={false} clickToPlay style={{ width: "100%" }} errorFallback={fail} />
          {safe ? (
            <div aria-hidden className="pointer-events-none absolute inset-0" data-testid="safe-area">
              <div className="absolute inset-x-0 top-0 border-b border-dashed border-white/70 bg-red-500/20" style={{ height: `${(theme.safe.top / theme.height) * 100}%` }} />
              <div className="absolute inset-x-0 bottom-0 border-t border-dashed border-white/70 bg-red-500/20" style={{ height: `${(theme.safe.bottom / theme.height) * 100}%` }} />
              <div className="absolute inset-y-0 left-0 bg-red-500/20" style={{ width: `${(theme.safe.side / theme.width) * 100}%` }} />
              <div className="absolute inset-y-0 right-0 bg-red-500/20" style={{ width: `${(theme.safe.side / theme.width) * 100}%` }} />
            </div>
          ) : null}
        </div>
        <p className="m-0 text-small text-muted">{data.audio.note}</p>
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="mb-1 text-small text-muted">Colours</legend>
          <div className="flex flex-wrap gap-2">
            <button type="button" aria-pressed={look === null} onClick={() => setLook(null)} className="min-h-9 rounded-control bg-raised px-3 text-small aria-pressed:outline aria-pressed:outline-2">This video&apos;s own</button>
            {LOOKS.map((l, i) => (
              <button key={l.name} type="button" aria-label={l.name} aria-pressed={look === i} onClick={() => setLook(i)} className="size-9 rounded-full border border-rule aria-pressed:outline aria-pressed:outline-2" style={{ background: `linear-gradient(135deg, ${l.from}, ${l.to})`, boxShadow: `inset -10px -10px 0 -4px ${l.accent}` }} />
            ))}
          </div>
        </fieldset>
        <label className="flex items-center gap-2 text-body"><input type="checkbox" checked={captions} disabled={!data.captions} onChange={(e) => setCaptions(e.target.checked)} /> Captions{data.captions ? "" : " (none yet)"}</label>
        <label className="flex items-center gap-2 text-body"><input type="checkbox" checked={safe} onChange={(e) => setSafe(e.target.checked)} /> Safe area</label>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <h3 className="m-0 text-section font-medium">Scenes ({data.rows.length})</h3>
        {risks.map((r) => <p key={r} className="m-0 text-small text-pill-warning-ink" data-testid="slideshow-warning">{r}</p>)}
        {data.documentProblems > 0 ? <p className="m-0 text-small text-pill-warning-ink">The scene file has a problem that is not about one scene. Use Re-check scenes on the Beats tab.</p> : null}
        <ol className="m-0 flex list-none flex-col gap-1 p-0" data-testid="scene-list">
          {data.rows.map((r) => (
            <li key={r.id}>
              <button type="button" onClick={() => ref.current?.seekTo(r.startFrame)} className="flex min-h-11 w-full items-center gap-3 rounded-control bg-surface px-3 text-left text-body hover:bg-raised sm:min-h-9">
                <span className="tabular-nums text-muted">{r.startLabel}</span>
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{r.kind.replace(/_/g, " ")}</span>
                <span aria-label={r.ok ? "Passed the checks" : "Has a problem"} className={r.ok ? "text-pill-positive-ink" : "text-pill-warning-ink"}>{r.ok ? "✓" : "!"}</span>
              </button>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

/** /dev/kit: every scene kind on its own small player, with sample data. */
export function KitSamples() {
  return (
    <ul className="m-0 grid list-none grid-cols-2 gap-4 p-0 sm:grid-cols-3 lg:grid-cols-6">
      {Object.keys(SAMPLE_SCENES).map((k) => {
        const doc = sampleDoc(k);
        return (
          <li key={k} className={box} data-kind={k}>
            <span className="text-small text-muted">{k}</span>
            <Player component={SampleScene} inputProps={{ scene: doc.scenes[0] as Scene }} compositionWidth={theme.width} compositionHeight={theme.height} fps={theme.fps} durationInFrames={Math.max(1, Math.round((doc.scenes[0]!.durationMs * theme.fps) / 1000))}
              controls loop allowFullscreen={false} style={{ width: "100%" }} errorFallback={fail} />
          </li>
        );
      })}
    </ul>
  );
}

const SampleScene = ({ scene }: { scene: Scene }) => <KitScene scene={scene} />;
