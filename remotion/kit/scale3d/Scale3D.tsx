import React, { useMemo } from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { ThreeCanvas } from "@remotion/three";
import * as THREE from "three";
import { beatFrames, beatIndexAt, cameraAt, cameraKeys, formatHeight, layoutObjects, rulerRangeAt, rulerStep, rulerValue, totalFrames } from "./math";
import type { Scale3dScene } from "../../../src/shared/scale3d";
import { Captions } from "../Captions";
import { captionStyleOf, presetOf } from "../presets";
import { theme } from "../theme";
import type { CaptionWord } from "../timeline";
import { HORIZON, World } from "./World";

export type Scale3DProps = { scene: Scale3dScene; captions?: CaptionWord[]; style?: string; captionStyle?: string };

/** Video length for a description, in frames (the Studio / render use this for calculateMetadata). */
export const scale3dFrames = (scene: Scale3dScene, fps: number): number => totalFrames(scene.beats.map((b) => b.duration_s), fps);

const FONT = "Impact, 'Arial Black', 'Helvetica Neue', Arial, sans-serif";
const fade = (v: number, a: number, b: number) => interpolate(v, [a, b], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

/** The ruler on the left: ticks from 0 to its top, a filled bar and a black chip that read the CAMERA's height. */
const Ruler: React.FC<{ value: number; max: number; step: number; ticks: boolean }> = ({ value, max, step, ticks }) => {
  const top = theme.safe.top + 300;
  const bottom = theme.height - theme.safe.bottom - 20;
  const track = bottom - top;
  const y = (v: number) => bottom - (Math.min(v, max) / max) * track;
  const yv = y(value);
  const marks: React.ReactNode[] = [];
  if (ticks) {
    for (let v = 0; v <= max + 1e-6; v += step) {
      const yy = y(v);
      const hide = Math.abs(yy - yv) < 80;
      marks.push(
        <div key={v} style={{ position: "absolute", left: theme.safe.side - 16, top: yy - 2, width: 46, height: 5, background: "#fff", boxShadow: "0 0 4px #0008" }} />,
        <div key={`l${v}`} style={{ position: "absolute", left: theme.safe.side + 38, top: yy - 18, color: "#fff", fontFamily: FONT, fontSize: 32, textShadow: "0 2px 6px #000a", opacity: hide ? 0 : 1 }}>{formatHeight(v)}</div>,
      );
    }
  }
  const x = theme.safe.side;
  return (
    <AbsoluteFill>
      <div style={{ position: "absolute", left: x, top, width: 10, height: track, background: "#0006", borderRadius: 5 }} />
      <div style={{ position: "absolute", left: x, top: yv, width: 10, height: bottom - yv, background: "#ffd21f", borderRadius: 5 }} />
      {marks}
      <div style={{ position: "absolute", left: x + 30, top: yv - 62, background: "#000", color: "#fff", fontFamily: FONT, fontSize: 104, lineHeight: "118px", padding: "0 28px", borderRadius: 14, border: "4px solid #fff", letterSpacing: 2, whiteSpace: "nowrap" }}>
        {formatHeight(value)}
      </div>
      <div style={{ position: "absolute", left: x - 18, top: yv - 14, width: 46, height: 28, background: "#ffd21f", clipPath: "polygon(0 50%, 40% 0, 100% 0, 100% 100%, 40% 100%)" }} />
    </AbsoluteFill>
  );
};

export const Scale3D: React.FC<Scale3DProps> = ({ scene, captions, style, captionStyle }) => {
  const frame = useCurrentFrame();
  const { fps, width, height, durationInFrames } = useVideoConfig();
  const durations = useMemo(() => scene.beats.map((b) => b.duration_s), [scene]);
  const beats = useMemo(() => beatFrames(durations, fps), [durations, fps]);
  const placements = useMemo(() => layoutObjects(scene.objects), [scene]);
  const keys = useMemo(() => cameraKeys(scene, placements), [scene, placements]);
  const pose = cameraAt(keys, frame / fps);
  const max = rulerRangeAt(scene, keys, frame / fps);
  const bi = beatIndexAt(beats, frame);
  const beat = scene.beats[bi]!;
  const local = frame - beats[bi]!.from;
  // The label eases in and out inside its beat; the whole overlay fades at the very ends so a looped video has a clean seam.
  const lab = Math.min(fade(local, 0, 9), fade(beats[bi]!.frames - local, 0, 8));
  const ends = Math.min(fade(frame, 0, 8), fade(durationInFrames - frame, 0, 8));
  const preset = presetOf(style);
  return (
    <AbsoluteFill style={{ background: `linear-gradient(#9fd0f0 0%, #cfe6f5 45%, ${HORIZON} 62%)` }}>
      <ThreeCanvas width={width} height={height} shadows camera={{ fov: 50, near: 0.5, far: 5000, position: [0, 50, 100] }} gl={{ antialias: true, toneMapping: THREE.NoToneMapping }} onCreated={({ gl }) => { gl.shadowMap.type = THREE.PCFSoftShadowMap; }}>
        <World scene={scene} placements={placements} pose={pose} />
      </ThreeCanvas>
      <AbsoluteFill style={{ opacity: ends }}>
        <Ruler value={rulerValue(pose)} max={max} step={rulerStep(max)} ticks={scene.ruler?.show_ticks !== false} />
        <div style={{ position: "absolute", left: theme.safe.side, right: theme.safe.side, top: theme.safe.top - 30, textAlign: "center", opacity: lab, transform: `scale(${0.9 + 0.1 * lab})` }}>
          <span style={{ fontFamily: FONT, fontSize: 104, lineHeight: "112px", color: "#fff", textTransform: "uppercase", WebkitTextStroke: "10px #000", paintOrder: "stroke fill", letterSpacing: 2, textShadow: "0 8px 0 #000" }}>{beat.label}</span>
        </div>
      </AbsoluteFill>
      {captions?.length ? <Captions words={captions} style={captionStyleOf(preset, captionStyle)} /> : null}
    </AbsoluteFill>
  );
};
