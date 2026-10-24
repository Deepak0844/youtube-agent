import React from "react";
import { AbsoluteFill } from "remotion";

// System-installed (vendored) families only: no @remotion/google-fonts, nothing fetched at render time.
// Layout contract with the test: six 260px bands starting at y=100, 300px apart.
const LINES: { text: string; family: string }[] = [
  { text: "क्षत्रिय श्री हिन्दी", family: "Noto Sans Devanagari" },
  { text: "தமிழ் கொடை", family: "Noto Sans Tamil" },
  { text: "తెలుగు శ్రీ", family: "Noto Sans Telugu" },
  { text: "അവൻ കേൾ മലയാളം", family: "Noto Sans Malayalam" },
  { text: "ಕನ್ನಡ ಶ್ರೀ", family: "Noto Sans Kannada" },
  { text: "YT Studio Ag", family: "Space Grotesk" },
];

export default function IndicCard() {
  return (
    <AbsoluteFill style={{ backgroundColor: "white" }}>
      {LINES.map((l, i) => (
        <div
          key={l.family}
          style={{
            position: "absolute",
            top: 100 + i * 300,
            left: 40,
            right: 40,
            height: 260,
            display: "flex",
            alignItems: "center",
            fontFamily: `"${l.family}"`,
            fontSize: 84,
            color: "black",
            whiteSpace: "nowrap",
            overflow: "hidden",
          }}
        >
          {l.text}
        </div>
      ))}
    </AbsoluteFill>
  );
}
