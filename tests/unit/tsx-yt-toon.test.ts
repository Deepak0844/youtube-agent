import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkTsx } from "@/server/core/tsx-check";
import { TOON_LIBS } from "@/server/core/toon-names";
import { typeCheckInThread } from "@/server/providers/renderer/tsx-render";
import { buildToonDts, indexDoc, INDEX_FILE, NAMES_FILE, namesModule, toonModules, TYPES_DIR } from "../../scripts/sync-toon-dts";

// Cartoon styles: code scenes may import cartoon-shorts' drawing kit as "yt-toon/<module>" (named imports only, like yt-old / yt-om).
// The names, declarations and Claude's index are GENERATED (scripts/sync-toon-dts.ts); the static check allows exactly them. Nothing
// else in the check changes: no tag, global, DOM or canvas rule is looser for a scene that imports yt-toon.

const scene = (imports: string, body = "<AbsoluteFill />") => `import { AbsoluteFill } from "remotion";
${imports}
export default function Film() {
  return ${body};
}
export const meta = { durationInFrames: 90, fps: 30, width: 1080, height: 1920 };
`;
const PUPPET = `import { ToonFilm, Scene } from "yt-toon/core";`;

describe("yt-toon declarations and names", () => {
  const { dts, names } = buildToonDts();
  it("names file matches the components", () => {
    expect(readFileSync(NAMES_FILE, "utf8")).toBe(namesModule(names));
    expect(readFileSync(INDEX_FILE, "utf8")).toBe(indexDoc(dts, names));
    for (const [rel, text] of dts) expect(readFileSync(path.join(TYPES_DIR, rel), "utf8"), rel).toBe(text);
  });
  it("covers core, fx and comic, and a scene cannot reach the page through them", () => {
    expect(Object.keys(TOON_LIBS).sort()).toEqual(toonModules().map((m) => `yt-toon/${m}`).sort());
    for (const n of ["ToonFilm", "Scene", "Ov", "Anim", "Show", "Camera"]) expect(TOON_LIBS["yt-toon/core"], n).toContain(n);
    expect(TOON_LIBS["yt-toon/comic"]).toContain("Puppet");
    expect(TOON_LIBS["yt-toon/fx"]).toContain("Burst");
    for (const bad of ["sceneParts", "useSceneId", "useToonBuild", "useRuntime", "createToonRuntime"]) expect(Object.values(TOON_LIBS).flat(), bad).not.toContain(bad);
  });
});

describe("yt-toon imports in the static check", () => {
  it("a scene importing yt-toon/comic Puppet passes the check", () => {
    const src = scene(`${PUPPET}\nimport { Puppet, P } from "yt-toon/comic";`, `<AbsoluteFill><ToonFilm><Scene id="hook"><Puppet who="Raju" act={() => ({ pose: P.stand, x: 540, y: 1200 })} /></Scene></ToonFilm></AbsoluteFill>`);
    expect(checkTsx(src).problems).toEqual([]);
  });
  it("a scene importing yt-toon/anime Bust passes the check", () => {
    const src = scene(`${PUPPET}\nimport { Bust } from "yt-toon/anime";`, `<AbsoluteFill><ToonFilm><Scene id="hook"><Bust look={{ hairStyle: "long" }} act={() => ({ x: 540, y: 800, s: 1.4, ex: { eyes: "open" } })} /></Scene></ToonFilm></AbsoluteFill>`);
    expect(checkTsx(src).problems).toEqual([]);
  });
  it("a scene importing yt-toon/manga Bust passes the check", () => {
    const src = scene(`${PUPPET}\nimport { Bust, Sfx } from "yt-toon/manga";`, `<AbsoluteFill><ToonFilm><Scene id="hook"><Bust look={{ head: "square", headband: "#2a7de1" }} act={() => ({ x: 540, y: 900, s: 1.2, ex: { mouth: "grin" } })} /><Sfx x={540} y={400} text="DON!!" /></Scene></ToonFilm></AbsoluteFill>`);
    expect(checkTsx(src).problems).toEqual([]);
  });
  it("a default import from yt-toon is refused", () => {
    expect(checkTsx(scene(`import Toon from "yt-toon/comic";`)).problems.join(" ")).toMatch(/default import/);
  });
  it("yt-toon/unknown is refused and the message lists yt-toon/*", () => {
    const p = checkTsx(scene(`import { X } from "yt-toon/unknown";`)).problems.join(" ");
    expect(p).toMatch(/not allowed/);
    expect(p).toContain("yt-toon/*");
  });
  it("an unlisted name and the internal helpers are refused", () => {
    for (const n of ["Nope", "sceneParts", "useToonBuild"]) expect(checkTsx(scene(`import { ${n} } from "yt-toon/core";`)).ok, n).toBe(false);
  });
  it("no rule other than imports changed", () => {
    const withToon = (body: string) => checkTsx(scene(`import { ToonFilm } from "yt-toon/core";`, body)).problems.join(" ");
    const without = (body: string) => checkTsx(scene("", body)).problems.join(" ");
    expect(withToon(`<canvas />`)).toBe(without(`<canvas />`));
    expect(withToon(`<AbsoluteFill>{document.title}</AbsoluteFill>`)).toBe(without(`<AbsoluteFill>{document.title}</AbsoluteFill>`));
    expect(withToon(`<AbsoluteFill onClick={() => window.alert(1)} />`)).toBe(without(`<AbsoluteFill onClick={() => window.alert(1)} />`));
    expect(withToon(`<AbsoluteFill />`)).toBe("");
  });
});

describe("yt-toon in the type-check", () => {
  it("typecheck resolves yt-toon and a wrong prop fails", async () => {
    const ok = await typeCheckInThread(scene(`import { Burst } from "yt-toon/fx";`, `<AbsoluteFill><svg><Burst cx={1} cy={2} r1={3} r2={4} n={5} fill="#fff" /></svg></AbsoluteFill>`), 60_000);
    expect(ok.problems).toEqual([]);
    const bad = await typeCheckInThread(scene(`import { Burst } from "yt-toon/fx";`, `<AbsoluteFill><svg><Burst nope={1} /></svg></AbsoluteFill>`), 60_000);
    expect(bad.ok).toBe(false);
  }, 120_000);
});
