import { describe, expect, it } from "vitest";
import { checkToon } from "@/server/core/toon-check";
import { toonInputFor } from "@/server/core/toon-input";

const beats = [0, 1, 2, 3].map((i) => ({ id: `b${i}`, text: `Beat number ${i} is here` }));
const words = Array.from({ length: 20 }, (_, i) => ({ word: `w${i}`, startS: i * 0.5, endS: i * 0.5 + 0.4 }));
const cast = [
  { name: "Raju", role: "the customer", style: "cartoon_comic" as const, options: {} },
  { name: "Meena", role: "the seller", style: "cartoon_comic" as const, options: {} },
];
const input = toonInputFor({ beats, words, durationS: 10, orientation: "portrait", cast });

const scene = (body: string, films = `<ToonFilm scenes={[{ id: "hook", from: "B0", to: "B3e" }]}>`) => `import { Scene, ToonFilm, Show, useToon } from "yt-toon/core";
import { Puppet, P } from "yt-toon/comic";
export default function Film() {
  const { t, T, prog } = useToon();
  return (
    ${films}
      <Scene id="hook">
        ${body}
      </Scene>
    </ToonFilm>
  );
}`;

describe("checkToon", () => {
  it("a scene that uses the cast and real beats passes", () => {
    expect(checkToon(scene(`<Puppet who="Raju" act={() => ({ pose: P.stand, x: 1, y: 2 })} /><Show from="B1%50" to="B3e"><g /></Show>`), input)).toEqual([]);
  });
  it("a name that is not in the cast is refused with the cast names, before any render", () => {
    const p = checkToon(scene(`<Puppet who="Ravi" act={() => ({ pose: P.stand, x: 1, y: 2 })} />`), input);
    expect(p).toHaveLength(1);
    expect(p[0]).toContain("cast: 'Ravi' is not in the cast (Raju, Meena); use one of those names or options={...} for a one-off.");
  });
  it("a beat past the end and a bad mark are refused with the mark and the beat count", () => {
    const a = checkToon(scene(`<Show from="B99" to="B3e"><g /></Show>`), input);
    expect(a[0]).toContain("no beat B99 (beats: 4)");
    expect(a[0]).toContain("B0 to B3");
    expect(checkToon(scene(`<Show from="B1" to="B3%x"><g /></Show>`), input)[0]).toContain("bad time B3%x");
  });
  it("marks in T() and prog() calls, and in enter / words entries, are checked too", () => {
    expect(checkToon(scene(`<g>{T("B7")}{prog(t, "B0", "B9")}</g>`), input)).toHaveLength(2);
    expect(checkToon(scene(`<g />`).replace("<Scene id=\"hook\">", `<Scene id="hook" words={[{ word: "X", x: 1, y: 2, rot: 0, at: "B8", until: "B9" }]}>`), input)).toHaveLength(2);
  });
  it("the film's scene windows must be beat marks, and a Scene must be one of them", () => {
    expect(checkToon(scene(`<g />`, `<ToonFilm scenes={[{ id: "hook", from: "B0", to: "B9e" }]}>`), input)[0]).toContain("scenes:");
    expect(checkToon(scene(`<g />`).replace('<Scene id="hook">', '<Scene id="other">'), input)[0]).toContain("is not in the film's scenes (hook)");
  });
  it("a computed name or mark cannot be read here and is left to the kit", () => {
    expect(checkToon(scene(`<Puppet who={name} act={() => ({ pose: P.stand, x: 1, y: 2 })} /><Show from={m} to="B3"><g /></Show>`), input)).toEqual([]);
  });
  it("seconds as numbers are not checked and elements that are not from yt-toon are ignored", () => {
    expect(checkToon(scene(`<Show from={0.2} to={3}><g /></Show><Other who="Nobody" from="B99" />`), input)).toEqual([]);
  });
});
