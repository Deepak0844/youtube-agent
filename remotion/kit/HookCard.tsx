import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { Headline, PhotoFit, useLook } from "./LookParts";
import { HOOK_BADGE, hookOpacity, lookBackground, popScale, shortTitle } from "./look";
import { theme } from "./theme";

/** Title card over the first scene: the video's best picture (or a drawn gradient), darkened bottom, big title, one badge. */
export const HookCard: React.FC<{ title?: string; src?: string }> = ({ title, src }) => {
  const look = useLook();
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ opacity: hookOpacity(frame), background: lookBackground(look), overflow: "hidden" }}>
      {src ? <PhotoFit src={src} box={{ x: 60, y: 260, w: theme.width - 120, h: 1000 }} zoom={1 / popScale(frame)} /> : null}
      <AbsoluteFill style={{ background: "linear-gradient(180deg, rgba(0,0,0,0.35) 0%, rgba(0,0,0,0) 22%, rgba(0,0,0,0) 45%, rgba(0,0,0,0.88) 100%)" }} />
      <div style={{ position: "absolute", top: 96, left: 64, padding: "14px 32px", borderRadius: 999, background: look.accent, color: look.from, fontSize: 44, fontWeight: 900, letterSpacing: 2, textTransform: "uppercase" }}>{HOOK_BADGE}</div>
      <div style={{ position: "absolute", left: 64, right: 64, bottom: 220, textShadow: "0 6px 24px rgba(0,0,0,0.7)" }}>
        <Headline text={shortTitle(title)} size={150} style={{ transform: "none", lineHeight: 1.05 }} />
      </div>
    </AbsoluteFill>
  );
};
