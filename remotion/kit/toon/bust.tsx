import React, { useContext, useLayoutEffect, useRef } from "react";
import { ToonContext, type ToonCharacter } from "./context";
import { useSceneId } from "./scene-parts";
import { useRuntime, useToonBuild } from "./Stage";
import type { ToonRuntime } from "./runtime";

/* eslint-disable @typescript-eslint/no-explicit-any */
// Internal: a bust component for one of cartoon-shorts' bust classes (Anime.Bust, Manga.Bust). The bust is redrawn from act(t) for every frame
// of its scene; draw() adds gradients and clip paths to <defs> on every call, so the ones the last frame made are dropped first.
export type BustProps = { who?: string; look?: Record<string, string | number | boolean | null>; act: (t: number) => { x: number; y: number; s: number; ex?: object } };

export function makeBust(pick: (rt: ToonRuntime, opts: Record<string, any>) => any, after?: (bust: any, opts: Record<string, any>) => void): React.FC<BustProps> {
  const C: React.FC<BustProps> = ({ who, look, act }) => {
    const rt = useRuntime();
    const input = useContext(ToonContext);
    const id = useSceneId();
    const ref = useRef<SVGGElement>(null);
    const actRef = useRef(act);
    useLayoutEffect(() => {
      actRef.current = act;
    });
    useToonBuild(() => {
      const member: ToonCharacter | undefined = who ? input?.cast.find((c) => c.name === who) : undefined;
      if (who && !member && !look) throw new Error(`cast: '${who}' is not in the cast (${(input?.cast ?? []).map((c) => c.name).join(", ") || "empty"})`);
      const opts = { ...(member?.options ?? {}), ...(look ?? {}) };
      const Cls = pick(rt, opts);
      const bust = new Cls(ref.current, opts);
      const info = rt.short.sceneById[id];
      let made: Element[] = [];
      rt.short.ups.push((t: number) => {
        if (!info || t < info.start || t >= info.end) return;
        const defs = (ref.current as SVGGElement).ownerSVGElement!.querySelector("defs")!;
        made.forEach((d) => d.remove());
        const before = new Set(Array.from(defs.children));
        const f = actRef.current(t);
        bust.draw(f.x, f.y, f.s, f.ex ?? {});
        after?.(bust, opts);
        made = Array.from(defs.children).filter((d) => !before.has(d));
      });
    });
    return <g ref={ref} />;
  };
  return C;
}
