import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OLD_LIBS } from "@/server/core/oldlib-names";
import { checkTsx } from "@/server/core/tsx-check";
import { typeCheckInThread } from "@/server/providers/renderer/tsx-render";

// Code scenes may import the old app's drawing libraries as "yt-old/<lib>" (old-kit-import). The static check allows exactly
// the generated names, the type-check types them from the generated declarations, and the render entry aliases only known
// libraries. Anything else under yt-old (a path, an unknown lib, a type, a name the lib does not export) is refused.

const scene = (imports: string, body = "<AbsoluteFill />") => `import { AbsoluteFill } from "remotion";
${imports}
export default function Scene() {
  return ${body};
}
export const meta = { durationInFrames: 90, fps: 30, width: 1080, height: 1920 };
`;

describe("yt-old imports in the static check", () => {
  it("yt_old_names_are_allowed_exactly", () => {
    expect(checkTsx(scene(`import { Captions, ProgressBar } from "yt-old/shorts";\nimport { COLORS } from "yt-old/brand";`)).problems).toEqual([]);
    expect(checkTsx(scene(`import { Nope } from "yt-old/shorts";`)).problems.join(" ")).toMatch(/Nope/);
  });

  it("yt_old_dotdot_and_unknown_are_refused", () => {
    for (const spec of ["yt-old/../tsxlib", "yt-old/geo/world", "yt-old/nothere", "yt-old", "yt-old/", "yt-old/./shorts"]) {
      expect(checkTsx(scene(`import { X } from "${spec}";`)).ok, spec).toBe(false);
    }
  });

  it("the libraries' own dependencies are not importable from a scene", () => {
    for (const spec of ["lucide-react", "chroma-js", "@remotion/google-fonts/Inter"]) expect(checkTsx(scene(`import X from "${spec}";`)).ok, spec).toBe(false);
  });
});

describe("yt-old in the type-check", () => {
  it("typecheck_resolves_yt_old", async () => {
    const good = scene(`import { BigTitle } from "yt-old/shorts";\nimport { COLORS } from "yt-old/brand";`, `<AbsoluteFill style={{ background: COLORS.bg }}><BigTitle text="Hi" /></AbsoluteFill>`);
    const r = await typeCheckInThread(good, 60_000);
    expect(r.problems.filter((p) => /Cannot find module|has no exported member/.test(p))).toEqual([]);
  }, 90_000);

  it("a wrong yt-old name fails the type-check too", async () => {
    const r = await typeCheckInThread(scene(`import { NotThere } from "yt-old/shorts";`), 60_000);
    expect(r.ok).toBe(false);
  }, 90_000);
});

describe("yt-old in the render entry", () => {
  const src = readFileSync("remotion/kit/render-entry.mjs", "utf8");
  it("render_entry_aliases_only_known_yt_old_names", () => {
    expect(src).toContain('"yt-old/"');
    expect(src).toMatch(/\/\^\[a-z\]\[a-z0-9\]\*\\\.tsx\?\$\//); // only plain top-level library files become aliases
    expect(Object.keys(OLD_LIBS).length).toBeGreaterThan(20);
  });
});
