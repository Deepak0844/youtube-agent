// One theme object for all kit pieces. Fonts are the families vendored in infra/render/fonts (no network).
export const theme = {
  width: 1080,
  height: 1920,
  fps: 30,
  palette: {
    bg: "#0b0d12",
    surface: "#161a23",
    text: "#f2f4f8",
    muted: "#8b93a7",
    accent: "#5eead4",
    bubbleMe: "#2563eb",
    bubbleThem: "#252b38",
    gridLine: "#2a3040",
    highlight: "#facc15",
    // Series / slice colours, in order.
    chart: ["#5eead4", "#60a5fa", "#f59e0b", "#f472b6", "#a78bfa", "#34d399", "#fb7185", "#fbbf24"],
  },
  fonts: { ui: "Inter", mono: "JetBrains Mono" },
  // Keep text inside these margins (px) so platform UI never covers it.
  safe: { top: 220, bottom: 380, side: 72 },
} as const;
export type Theme = typeof theme;
