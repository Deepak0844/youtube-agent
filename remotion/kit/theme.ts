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
  // Flat drawn-object colours (outline, metals, glass, status lights).
  art: {
    ink: "#0f1218",
    steel: "#3a3f4b",
    steelLight: "#5b6272",
    glass: "#cfe6ec",
    liquid: "#5eead4",
    paper: "#e8dfc9",
    cloud: "#e8f1f5",
    ok: "#58e08a",
    warn: "#fbbf24",
    blue: "#2b7fc4",
    boardLight: "#c9d1e0",
    boardDark: "#5b6b8c",
    pieceLight: "#f2f4f8",
    pieceDark: "#10131a",
  },
  fonts: { ui: "Inter", mono: "JetBrains Mono" },
  // Keep text inside these margins (px) so platform UI never covers it.
  safe: { top: 220, bottom: 380, side: 72 },
} as const;
export type Theme = typeof theme;
