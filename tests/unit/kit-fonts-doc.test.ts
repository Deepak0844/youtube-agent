import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dir = "remotion/kit/fonts";

describe("kit fonts doc", () => {
  it("every ttf is listed in FONTS.md", () => {
    const doc = readFileSync(`${dir}/FONTS.md`, "utf8");
    const ttfs = readdirSync(dir).filter((f) => f.endsWith(".ttf"));
    expect(ttfs.length).toBeGreaterThan(0);
    for (const f of ttfs) expect(doc).toContain(f);
  });
});
