import type { CSSProperties, ReactNode } from "react";
import { PRESETS, type AnyStyleId, type StyleId } from "../../../../../remotion/kit/presets";

// A small drawn frame of each style: flat CSS shapes in the owner-approved palette (`sheet`), sized with container units so it
// scales from a 2-column phone grid up. An approximation to compare moods, not a render. The render fonts are not loaded in the app,
// so the heading sample shows the real font only where it is installed, else a close system font.
const abs = (s: CSSProperties): CSSProperties => ({ position: "absolute", ...s });
const Box = ({ s, children }: { s: CSSProperties; children?: ReactNode }) => <div style={abs(s)}>{children}</div>;

function Frame({ id }: { id: StyleId }) {
  const p = PRESETS[id];
  const c = p.sheet ?? [];
  const h = (size: number, extra?: CSSProperties): CSSProperties => ({ fontFamily: `"${p.fonts.heading}", system-ui, sans-serif`, fontWeight: p.fonts.headingWeight, fontSize: `${size}cqw`, lineHeight: 1.05, ...extra });
  switch (id) {
    case "clean_professional":
      return <>
        <Box s={{ inset: 0, background: c[0] }} />
        <Box s={{ left: "8%", top: "9%", right: "8%", color: c[1], ...h(11) }}>How a load balancer works</Box>
        <Box s={{ left: "8%", top: "36%", width: "84%", height: "2.5%", background: c[2], borderRadius: 4 }} />
        {[0, 1, 2].map((i) => <Box key={i} s={{ left: `${8 + i * 31}%`, top: "50%", width: "24%", height: "22%", borderRadius: 8, background: "#EFF4FF", border: `2px solid ${c[2]}` }} />)}
      </>;
    case "flat_motion":
      return <>
        <Box s={{ inset: 0, background: c[0] }} />
        <Box s={{ left: "8%", top: "9%", right: "8%", color: c[1], ...h(11) }}>AI agents, <span style={{ color: c[4] }}>explained fast</span></Box>
        <Box s={{ left: "14%", top: "40%", width: "42%", aspectRatio: "1", borderRadius: "50%", background: c[2] }} />
        <Box s={{ left: "46%", top: "50%", width: "36%", aspectRatio: "1", borderRadius: "50%", border: `4px solid ${c[3]}` }} />
      </>;
    case "minimal_diagram":
      return <>
        <Box s={{ inset: 0, background: c[0] }} />
        <Box s={{ left: "8%", top: "9%", color: c[1], ...h(11) }}>Binary search</Box>
        <svg viewBox="0 0 100 100" style={abs({ left: "6%", top: "30%", width: "88%", height: "50%" })} fill="none" stroke={c[1]} strokeWidth="1">
          <rect x="8" y="8" width="26" height="14" /><rect x="66" y="8" width="26" height="14" />
          <rect x="37" y="42" width="26" height="14" stroke={c[2]} strokeWidth="1.6" /><rect x="8" y="76" width="26" height="14" /><rect x="66" y="76" width="26" height="14" />
          <path d="M21 22 L50 42 M79 22 L50 42 M50 56 L21 76 M50 56 L79 76" />
        </svg>
      </>;
    case "premium_editorial":
      return <>
        <Box s={{ inset: 0, background: c[0] }} />
        <Box s={{ left: "8%", top: "10%", color: c[2], fontSize: "4cqw", letterSpacing: "0.14em", fontFamily: "ui-monospace, monospace" }}>THE GRID</Box>
        <Box s={{ left: "8%", top: "17%", color: c[1], letterSpacing: "-0.05em", ...h(40, { lineHeight: 0.9 }) }}>21%</Box>
        <Box s={{ left: "8%", right: "8%", top: "52%", height: 2, background: c[1] }} />
        <Box s={{ left: "8%", top: "80%", width: "32%", height: "2%", background: c[3] }} />
      </>;
    case "storybook_calm":
      return <>
        <Box s={{ inset: 0, background: `radial-gradient(circle at 70% 24%, #2a2350, ${c[0]} 60%)` }} /> {/* taste-skill-ignore: draws the video look itself, not app chrome */}
        <Box s={{ left: "62%", top: "20%", width: "20%", aspectRatio: "1", borderRadius: "50%", background: "#FFE9B5", boxShadow: "0 0 24px 8px rgba(255,200,120,.45)" }} />
        <Box s={{ left: "-10%", right: "-10%", bottom: "-6%", height: "34%", background: "#143324", borderRadius: "55% 45% 0 0" }} />
        {[[20, 50], [34, 60], [58, 54], [72, 64]].map(([x, y]) => <Box key={x} s={{ left: `${x}%`, top: `${y}%`, width: 5, height: 5, borderRadius: "50%", background: c[2], boxShadow: "0 0 8px 3px rgba(255,179,71,.6)" }} />)}
        <Box s={{ left: "8%", right: "8%", top: "9%", color: c[1], ...h(10) }}>Why the sky glows at dusk</Box>
      </>;
    case "paper_cutout":
      return <>
        <Box s={{ inset: 0, background: c[0] }} />
        <Box s={{ left: 0, right: 0, top: "14%", height: "14%", background: c[1], transform: "rotate(-1.5deg)", boxShadow: "0 4px 6px rgba(0,0,0,.35)", display: "flex", alignItems: "center", justifyContent: "center", color: "#1C1B17", ...h(8, { textTransform: "uppercase" }) }}>Power in 3 steps</Box>
        <Box s={{ left: "14%", top: "38%", width: "42%", aspectRatio: "1", background: c[2], borderRadius: "46% 54% 50% 50%", boxShadow: "0 5px 8px rgba(0,0,0,.4)" }} />
        <Box s={{ left: "52%", top: "52%", width: "32%", aspectRatio: "1.1", background: "#8A7A60", borderRadius: 8, transform: "rotate(5deg)", boxShadow: "0 5px 8px rgba(0,0,0,.4)" }} />
        <Box s={{ left: "28%", bottom: "9%", background: `color-mix(in srgb, ${c[3]} 85%, black)`, color: "#F3E6D3", padding: "1cqw 4cqw", transform: "rotate(-4deg)", boxShadow: "0 3px 5px rgba(0,0,0,.4)", ...h(8) , fontFamily: '"Fraunces", Georgia, serif' }}>spins</Box>
      </>;
    case "kinetic_type":
      return <>
        <Box s={{ inset: 0, background: c[0] }} />
        <Box s={{ left: "8%", right: "6%", top: "10%", color: c[1], textTransform: "uppercase", ...h(19, { lineHeight: 0.92 }) }}>One<br /><span style={{ color: c[2] }}>trick</span><br />for <span style={{ color: c[3] }}>20</span></Box>
        <Box s={{ left: "8%", top: "86%", width: "22%", height: 5, background: c[2] }} />
      </>;
    case "retention_shorts":
      return <>
        <Box s={{ inset: 0, background: `linear-gradient(170deg, ${c[0]}, ${c[1]})` }} /> {/* taste-skill-ignore: draws the video look itself, not app chrome */}
        <Box s={{ left: "6%", right: "6%", top: "9%", textAlign: "center", color: "#fff", textTransform: "uppercase", WebkitTextStroke: "1px #000", ...h(10) }}>You&apos;re doing this wrong</Box>
        <Box s={{ left: "16%", right: "16%", top: "34%", aspectRatio: "1", background: "rgba(255,255,255,.12)", border: `3px solid ${c[2]}`, borderRadius: 14 }} />
        <Box s={{ left: "6%", right: "6%", top: "78%", textAlign: "center", color: "#fff", WebkitTextStroke: "1px #000", ...h(10) }}>STOP <span style={{ color: c[2] }}>GUESSING</span></Box>
      </>;
    case "wrapped_stats":
      return <>
        <Box s={{ inset: 0, background: `radial-gradient(circle at 20% 10%, #2b1b63, ${c[0]} 60%)` }} /> {/* taste-skill-ignore: draws the video look itself, not app chrome */}
        <Box s={{ left: "8%", top: "10%", color: c[2], fontSize: "4cqw", letterSpacing: "0.14em", fontFamily: "ui-monospace, monospace" }}>YOUR YEAR</Box>
        <Box s={{ left: "8%", top: "16%", color: c[1], ...h(36, { lineHeight: 0.9 }) }}>21%</Box>
        {[92, 74, 55, 41].map((w, i) => <Box key={w} s={{ left: "8%", top: `${52 + i * 9}%`, width: `${w * 0.8}%`, height: "5%", borderRadius: 3, background: i % 2 ? c[3] : c[2] }} />)}
      </>;
    case "ai_studio":
      return <>
        <Box s={{ inset: 0, background: `radial-gradient(circle at 25% 18%, rgba(99,102,241,.55), transparent 55%), radial-gradient(circle at 80% 70%, rgba(77,184,168,.32), transparent 55%), ${c[0]}` }} /> {/* taste-skill-ignore: draws the video look itself, not app chrome */}
        <Box s={{ left: "8%", right: "8%", top: "9%", color: "#fff", ...h(10) }}>How electricity is <span style={{ color: c[4] }}>really made</span></Box>
        <Box s={{ left: "28%", top: "30%", width: "44%", aspectRatio: "1", borderRadius: "50%", background: `radial-gradient(circle, #fff3c4, ${c[4]} 45%, transparent 70%)` }} /> {/* taste-skill-ignore: draws the video look itself, not app chrome */}
        <Box s={{ left: "18%", top: "62%", width: "64%", aspectRatio: "2.2", borderRadius: "50%", border: `5px solid ${c[1]}`, boxShadow: `0 0 16px ${c[1]}` }} />
      </>;
  }
}

/** The drawn frame for one style id, or a plain gradient for the Classic default (its colours change per video). */
export function StyleMock({ id }: { id: AnyStyleId | "" }) {
  return (
    <div aria-hidden className="relative aspect-[9/13] w-full overflow-hidden rounded-control" style={{ containerType: "inline-size" }}>
      {id === "" || !PRESETS[id].sheet ? (
        <div className="absolute inset-0" style={{ background: "linear-gradient(165deg, #0a1640, #1e40af)" }}> {/* taste-skill-ignore: draws the video look itself, not app chrome */}
          <div className="absolute top-[10%] right-[10%] left-[10%] text-[10cqw] leading-tight font-black text-white">Colours change every video</div>
        </div>
      ) : (
        <Frame id={id as StyleId} />
      )}
    </div>
  );
}
