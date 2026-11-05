// Stage: the one wrapper a scene file renders. It reads the Remotion frame, gives every piece the time (useT), draws a ThreeCanvas
// with the renderer settings the look needs (ACES tone mapping, soft shadows, no canvas MSAA because <Finish> does it), and layers
// your HTML overlay (captions) on top. An error inside the 3D part shows as text on the frame instead of a blank video.
import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { ThreeCanvas } from "@remotion/three";
import * as THREE from "three";
import { TimeContext } from "./time";
import { FOV_DEG } from "./framing";

class Boundary extends React.Component<{ children: React.ReactNode }, { e: string }> {
  override state = { e: "" };
  static getDerivedStateFromError(e: unknown) { return { e: String((e instanceof Error && e.stack) || e) }; }
  override render() { return this.state.e ? <pre style={{ fontSize: 18, color: "red", whiteSpace: "pre-wrap", background: "#fff" }}>{this.state.e.slice(0, 1800)}</pre> : this.props.children; }
}

export type StageProps = {
  /** 3D content: <World/>, <CameraRig/>, your objects, then <Finish/> last. */
  children: React.ReactNode;
  /** HTML drawn over the picture: <Captions/>. */
  overlay?: React.ReactNode;
  /** Page colour behind the canvas (default: the haze colour). */
  background?: string;
};

export const Stage: React.FC<StageProps> = ({ children, overlay, background = "#d6e6ee" }) => {
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  const t = frame / fps;
  return (
    <TimeContext.Provider value={t}>
      <AbsoluteFill style={{ background }}>
        <Boundary>
          <ThreeCanvas width={width} height={height} shadows dpr={1} camera={{ fov: FOV_DEG, near: 1, far: 3500, position: [0, 0, 0] }}
            gl={{ antialias: false, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.05 }}
            onCreated={({ gl }) => { gl.shadowMap.type = THREE.PCFShadowMap; gl.localClippingEnabled = true; }}>
            {/* the canvas is a separate React tree: the time context is given again inside it */}
            <TimeContext.Provider value={t}>{children}</TimeContext.Provider>
          </ThreeCanvas>
        </Boundary>
        {overlay}
      </AbsoluteFill>
    </TimeContext.Provider>
  );
};
