// The old app's 3-font brand system (plus a serif and an editorial serif), adapted for the locked render box: the faces are
// installed in the render image (infra/render/fonts, OFL), so they are named here instead of downloaded from Google Fonts
// at render time (the box has no network). Same families as the old app, so old shorts look the same.

// Hindi, Tamil, Telugu, Malayalam and Kannada captions: the Latin fonts have no glyphs for them, so the browser falls back, glyph by glyph,
// to the Noto families installed in the render image. Latin text is unchanged.
const INDIC_FALLBACK = '"Noto Sans Tamil", "Noto Sans Telugu", "Noto Sans Malayalam", "Noto Sans Kannada", "Noto Sans Devanagari", sans-serif';
export const FONT_DISPLAY = `"Space Grotesk", ${INDIC_FALLBACK}`;
export const FONT_BODY = `"Inter", ${INDIC_FALLBACK}`;
export const FONT_MONO = '"JetBrains Mono", monospace';
// serif for the Claude Code wordmark clone (close match to the app's serif)
export const FONT_SERIF = '"Spectral", serif';
// heavy editorial serif for the vox collage engine's headlines
export const FONT_EDITORIAL = '"Source Serif 4", serif';
