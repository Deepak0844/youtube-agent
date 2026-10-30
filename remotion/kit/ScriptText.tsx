import React from "react";
import { continueRender, delayRender } from "remotion";
import deva from "./fonts/NotoSansDevanagari-Variable.ttf";
import kannada from "./fonts/NotoSansKannada-Variable.ttf";
import malayalam from "./fonts/NotoSansMalayalam-Variable.ttf";
import tamil from "./fonts/NotoSansTamil-Variable.ttf";
import telugu from "./fonts/NotoSansTelugu-Variable.ttf";
import { splitByScript, type Script } from "./script";
import { theme } from "./theme";

const FILES: Record<Exclude<Script, "latin">, [string, string]> = {
  devanagari: ["Noto Sans Devanagari", deva],
  tamil: ["Noto Sans Tamil", tamil],
  telugu: ["Noto Sans Telugu", telugu],
  kannada: ["Noto Sans Kannada", kannada],
  malayalam: ["Noto Sans Malayalam", malayalam],
};

let loading: Promise<unknown> | null = null;
function loadFonts() {
  if (loading || typeof document === "undefined") return;
  const handle = delayRender("indic fonts");
  loading = Promise.all(
    Object.values(FILES).map(([family, url]) =>
      new FontFace(family, `url(${url})`, { weight: "100 900" }).load().then((f) => document.fonts.add(f)),
    ),
  ).finally(() => continueRender(handle));
}

/** Text with the right Noto font per run (hi/ta/te/kn/ml), theme UI font for Latin. */
export const ScriptText: React.FC<{ text: string; font?: string }> = ({ text, font = theme.fonts.ui }) => {
  loadFonts();
  return (
    <>
      {splitByScript(text).map((r, i) => (
        <span key={i} style={{ fontFamily: r.script === "latin" ? font : `"${FILES[r.script][0]}", ${font}` }}>
          {r.text}
        </span>
      ))}
    </>
  );
};
