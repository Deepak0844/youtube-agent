import React, { createContext, useContext } from "react";
import { Img, continueRender, delayRender, useCurrentFrame } from "remotion";
import { fitContain, keyWordIndex, LOOKS, popScale, type Look } from "./look";
import { ScriptText } from "./ScriptText";
import { theme } from "./theme";

/** The style's banner type: heading font and weight, and (paper cutout) the tilted, shadowed, boiling banner. Absent = today's headline. */
export type Banner = { font: string; weight: number; paper?: boolean };
type Ctx = { look: Look; sceneCaptions: boolean; banner?: Banner };
const LookCtx = createContext<Ctx>({ look: LOOKS[0]!, sceneCaptions: true });
export const LookProvider = LookCtx.Provider;
export const useLook = (): Look => useContext(LookCtx).look;
/** False while the word captions are on screen. */
export const useSceneCaptions = (): boolean => useContext(LookCtx).sceneCaptions;
const useBanner = (): Banner | undefined => useContext(LookCtx).banner;

/** Headline in thick type with its key word in the accent colour; pops in. */
export const Headline: React.FC<{ text: string; size?: number; style?: React.CSSProperties }> = ({ text, size = 64, style }) => {
  const look = useLook();
  const banner = useBanner();
  const frame = useCurrentFrame();
  const words = text.split(" ");
  const k = keyWordIndex(words);
  // Paper cutout: 2-frame boil (a tiny tilt flip every 2 frames) and a soft paper shadow.
  const boil = banner?.paper ? { transform: `scale(${popScale(frame)}) rotate(${Math.floor(frame / 2) % 2 ? -0.6 : 0.6}deg)`, textShadow: "0 4px 8px rgba(0,0,0,0.4)" } : {};
  return (
    <div style={{ fontSize: size, fontWeight: banner?.weight ?? 900, lineHeight: 1.1, transform: `scale(${popScale(frame)})`, transformOrigin: "left center", ...boil, ...style }}>
      {words.map((w, i) => (
        <span key={i} style={{ color: i === k ? look.accent : theme.palette.text }}>
          <ScriptText text={w} font={banner?.font} />
          {i < words.length - 1 ? " " : ""}
        </span>
      ))}
    </div>
  );
};

function useNatural(src: string): { w: number; h: number } | null {
  const [nat, setNat] = React.useState<{ w: number; h: number } | null>(null);
  React.useEffect(() => {
    const handle = delayRender(`size ${src.slice(0, 40)}`);
    const im = new window.Image();
    const done = (n: { w: number; h: number } | null) => {
      setNat(n ?? { w: 1, h: 1 });
      continueRender(handle);
    };
    im.onload = () => done({ w: im.naturalWidth || 1, h: im.naturalHeight || 1 });
    im.onerror = () => done(null);
    im.src = src;
  }, [src]);
  return nat;
}

/**
 * A whole picture, never cropped: sharp inside a rounded accent frame over a blurred, darkened copy of itself.
 * `box` is where the sharp picture may sit; the blur fills the parent. `zoom` is a gentle scale (<= 1.06) on the frame.
 */
export const PhotoFit: React.FC<{ src: string; box: { x: number; y: number; w: number; h: number }; zoom?: number; tx?: number; ty?: number; radius?: number; border?: number }> = ({
  src,
  box,
  zoom = 1,
  tx = 0,
  ty = 0,
  radius = 28,
  border = 6,
}) => {
  const look = useLook();
  const frame = useCurrentFrame();
  const nat = useNatural(src);
  const r = nat ? fitContain(nat, box) : box;
  return (
    <>
      <Img src={src} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", filter: "blur(40px) brightness(0.45)", transform: "scale(1.2)" }} />
      {nat ? (
        <Img
          src={src}
          style={{
            position: "absolute",
            left: r.x,
            top: r.y,
            width: r.w,
            height: r.h,
            boxSizing: "border-box",
            borderRadius: radius,
            border: `${border}px solid ${look.accent}`,
            boxShadow: "0 18px 48px rgba(0,0,0,0.55)",
            transform: `translate(${tx}px, ${ty}px) scale(${zoom * popScale(frame)})`,
          }}
        />
      ) : null}
    </>
  );
};
