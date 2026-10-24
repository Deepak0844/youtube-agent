# Vendored fonts for the render image

All files are licensed under the SIL Open Font License 1.1 (see the matching OFL-*.txt). They are copied into the image at build time; nothing is fetched at runtime. Replaces `@remotion/google-fonts`. Source repo: https://github.com/google/fonts (path `ofl/<family>/`).

| File | Family | Source URL | Licence |
|---|---|---|---|
| SpaceGrotesk-Variable.ttf | Space Grotesk | https://github.com/google/fonts/raw/main/ofl/spacegrotesk/SpaceGrotesk%5Bwght%5D.ttf | OFL-1.1, OFL-SpaceGrotesk.txt |
| Inter-Variable.ttf | Inter | https://github.com/google/fonts/raw/main/ofl/inter/Inter%5Bopsz%2Cwght%5D.ttf | OFL-1.1, OFL-Inter.txt |
| JetBrainsMono-Variable.ttf | JetBrains Mono | https://github.com/google/fonts/raw/main/ofl/jetbrainsmono/JetBrainsMono%5Bwght%5D.ttf | OFL-1.1, OFL-JetBrainsMono.txt |
| Spectral-Medium.ttf | Spectral | https://github.com/google/fonts/raw/main/ofl/spectral/Spectral-Medium.ttf | OFL-1.1, OFL-Spectral.txt |
| Spectral-SemiBold.ttf | Spectral | https://github.com/google/fonts/raw/main/ofl/spectral/Spectral-SemiBold.ttf | OFL-1.1, OFL-Spectral.txt |
| SourceSerif4-Variable.ttf | Source Serif 4 | https://github.com/google/fonts/raw/main/ofl/sourceserif4/SourceSerif4%5Bopsz%2Cwght%5D.ttf | OFL-1.1, OFL-SourceSerif4.txt |
| NotoSansDevanagari-Variable.ttf | Noto Sans Devanagari | https://github.com/google/fonts/raw/main/ofl/notosansdevanagari/NotoSansDevanagari%5Bwdth%2Cwght%5D.ttf | OFL-1.1, OFL-NotoSansDevanagari.txt |
| NotoSansTamil-Variable.ttf | Noto Sans Tamil | https://github.com/google/fonts/raw/main/ofl/notosanstamil/NotoSansTamil%5Bwdth%2Cwght%5D.ttf | OFL-1.1, OFL-NotoSansTamil.txt |
| NotoSansTelugu-Variable.ttf | Noto Sans Telugu | https://github.com/google/fonts/raw/main/ofl/notosanstelugu/NotoSansTelugu%5Bwdth%2Cwght%5D.ttf | OFL-1.1, OFL-NotoSansTelugu.txt |
| NotoSansMalayalam-Variable.ttf | Noto Sans Malayalam | https://github.com/google/fonts/raw/main/ofl/notosansmalayalam/NotoSansMalayalam%5Bwdth%2Cwght%5D.ttf | OFL-1.1, OFL-NotoSansMalayalam.txt |
| NotoSansKannada-Variable.ttf | Noto Sans Kannada | https://github.com/google/fonts/raw/main/ofl/notosanskannada/NotoSansKannada%5Bwdth%2Cwght%5D.ttf | OFL-1.1, OFL-NotoSansKannada.txt |

Brand families come from the old project's fonts.ts (Space Grotesk display, Inter body, JetBrains Mono mono, Spectral serif, Source Serif 4 editorial). Indic fallbacks are the Noto Sans families named in its INDIC_FALLBACK. Variable fonts are used where upstream ships only a variable file; Spectral is static upstream.
