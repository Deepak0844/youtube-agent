import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The render image and package.json must pin the same Remotion versions (bundled in one, previewed with the other).
const docker = readFileSync("infra/Dockerfile.render", "utf8");
const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { dependencies: Record<string, string> };
const inImage = (name: string) => {
  const esc = name.replace(/[/@]/g, (c) => `\\${c}`);
  return new RegExp(`(?:^|\\s)${esc}@(\\d+\\.\\d+\\.\\d+)(?=\\s|$)`, "m").exec(docker)?.[1];
};

describe("render image pins match package.json", () => {
  it.each(["remotion", "@remotion/shapes", "@remotion/paths", "react", "react-dom"])("%s", (name) => {
    expect(inImage(name)).toBeDefined();
    expect(pkg.dependencies[name]).toBe(inImage(name));
  });
});
