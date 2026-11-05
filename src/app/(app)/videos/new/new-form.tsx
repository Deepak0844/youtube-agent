"use client";

import { useActionState, useState } from "react";
import { LOOKS } from "../../../../../remotion/kit/look";
import { PRESETS, STYLE_IDS } from "../../../../../remotion/kit/presets";
import { LANGUAGE_ORDER, LANGUAGE_WORDS } from "@/server/core/videos-view";
import { cn, control, fade, focusRing } from "@/ui/lib/cn";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { Label } from "@/ui/primitives/label";
import { StyleMock } from "./style-mock";
import { createVideoAction, type NewVideoState } from "./actions";

const selectClass = cn("w-full rounded-control border border-control bg-surface px-4 text-body text-text disabled:opacity-50", control, fade, focusRing);

export function NewForm({ scaleLimitNote, scene3dNote }: { scaleLimitNote: string | null; scene3dNote: string | null }) {
  const [state, run, pending] = useActionState<NewVideoState, FormData>(createVideoAction, {});
  const [kind, setKind] = useState<"scene_kit" | "tsx" | "scale3d" | "scene3d" | "scene3d_code">("scene_kit");
  const custom = kind === "tsx";
  const scale = kind === "scale3d" || kind === "scene3d" || kind === "scene3d_code"; // both draw their own look: no style or caption pickers
  // Custom animation has no Classic look: its default card is AI Studio. Scene kit keeps Classic ("" = no style).
  const [picked, setPicked] = useState("");
  const style = custom && picked === "" ? "ai_studio" : picked;
  return (
    <form action={run} className="flex max-w-xl min-w-0 flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Label htmlFor="topic">Topic</Label>
        <Input id="topic" name="topic" required maxLength={200} placeholder="Why is the sky blue?" aria-describedby="topic-help" autoComplete="off" />
        <p id="topic-help" className="m-0 text-small text-faint">Up to 200 characters.</p>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="language">Narration language</Label>
        <select id="language" name="language" defaultValue="en" className={selectClass}>
          {LANGUAGE_ORDER.map((l) => (
            <option key={l} value={l}>
              {LANGUAGE_WORDS[l]} ({l})
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-5 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="format">Format</Label>
          <select id="format" name="format" defaultValue="short" className={selectClass}>
            <option value="short">Short</option>
            <option value="long" disabled>Long (Phase 6b)</option>
          </select>
        </div>
      </div>
      <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
        <legend className="mb-1 text-body font-medium">Video type</legend>
        {(
          [
            ["scene_kit", "Scene kit (default)", "Safe and fast: the app builds the scenes from a fixed set of parts."],
            ["tsx", "Custom animation (TSX, experimental)", "Claude writes the animation code. Slower, and it may fall back to the scene kit if the code does not pass the safety checks."],
            ["scale3d", "3D scale comparison (Shorts)", "Sizes compared on a ruler: a camera climbs past real objects. Every height is a claim you verify. Needs the render time limit set to 900 s or more (Settings > System)."],
            ["scene3d_code", "3D story (AI-written scene)", "The AI writes the whole 3D scene as code, from the free building blocks and CC0 models. The app checks the code line by line, runs it only in a locked box on this Mac, and you approve the look from preview pictures before the long render. Needs 'Render 3D on this Mac' turned on in System settings."],
            ["scene3d", "3D story (detailed)", "A 60 s illustrated 3D story built from free CC0 models. You approve the look from preview pictures before the long render. Needs 'Render 3D on this Mac' turned on in System settings."],
          ] as const
        ).map(([id, title, help]) => (
          <label key={id} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-card border border-rule bg-surface p-3 has-checked:outline-2 has-checked:outline">
            <input type="radio" name="kind" value={id} checked={kind === id} onChange={() => setKind(id)} className="mt-1" />
            <span className="flex min-w-0 flex-col gap-1">
              <span className="text-body font-medium">{title}</span>
              <span className="text-small text-muted">{help}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {(kind === "scene3d" || kind === "scene3d_code") && scene3dNote ? <p role="note" data-testid="scene3d-native-note" className="m-0 max-w-[68ch] rounded-card bg-pill-warning-bg p-4 text-body text-pill-warning-ink">{scene3dNote}</p> : null}
      {kind === "scale3d" && scaleLimitNote ?<p role="note" data-testid="render-limit-note" className="m-0 max-w-[68ch] rounded-card bg-pill-warning-bg p-4 text-body text-pill-warning-ink">{scaleLimitNote}</p> : null}
      {scale ? null : (
      <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
        <legend className="mb-1 text-body font-medium">Style</legend>
        {custom ? <p className="m-0 text-small text-muted">Claude draws the animation in this style: its colours, fonts, motion and pace.</p> : null}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {([...(custom ? [] : [["", null] as const]), ...STYLE_IDS.map((id) => [id, PRESETS[id]] as const)] as const).map(([id, s]) => (
            <label key={id || "classic"} className="relative flex min-w-0 cursor-pointer flex-col gap-2 rounded-card border border-rule bg-surface p-2 has-checked:outline-2 has-checked:outline has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline">
              <input type="radio" name="style" value={id} checked={style === id} onChange={() => setPicked(id)} className="sr-only" />
              <StyleMock id={id} />
              <span className="flex min-w-0 flex-col gap-1">
                <span className="text-body font-medium">{s ? s.label : "Classic (default)"}</span>
                <span aria-hidden className="flex h-3 overflow-hidden rounded-full border border-rule">
                  {(s?.sheet ?? LOOKS.slice(0, 4).map((l) => l.to)).map((c) => <span key={c} className="flex-1" style={{ background: c }} />)}
                </span>
                <span aria-hidden className="truncate text-body" style={{ fontFamily: `"${s?.fonts.heading ?? "Inter"}", system-ui, sans-serif`, fontWeight: s?.fonts.headingWeight ?? 800 }}>Aa {s?.fonts.heading ?? "Inter"}</span>
                <span className="text-small text-muted">{s ? s.mood : "The original look, with a new colour mix for every video."}</span>
                {s?.bestFor ? <span className="text-small text-faint">Best for: {s.bestFor}</span> : null}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      )}
      {scale ? null : (
      <label className="flex items-start gap-3 text-body">
        <input type="checkbox" name="captionStyle" value="punchy_captions" disabled={custom} className="mt-1" />
        <span>Punchy captions <span className="block text-small text-muted">Big 1-3 word captions, yellow active word, black outline. Works with any style.{custom ? " Not used for custom animation, which has its own captions." : ""}</span></span>
      </label>
      )}
      <div className="flex flex-col gap-2">
        <Label htmlFor="notes">Notes (optional)</Label>
        <textarea id="notes" name="notes" rows={4} maxLength={2000} placeholder="Angle, tone, things to include or avoid" className={cn(selectClass, "py-2")} />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Starting..." : "Start video"}
        </Button>
        {state.message ? (
          <p role="alert" className="m-0 text-body text-pill-negative-ink">
            {state.message}
          </p>
        ) : null}
      </div>
    </form>
  );
}
