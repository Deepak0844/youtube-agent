import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkTsx } from "@/server/core/tsx-check";
import { typeCheckInThread } from "@/server/providers/renderer/tsx-render";

// The cartoon examples the engine reads (engine-kit/examples/cartoon-*) are written with yt-toon only, so they must pass exactly the
// checks an engine-written scene passes. Their exactness against cartoon-shorts is proved by scripts/toon-compare.ts (dev only).
const root = path.resolve(__dirname, "../../engine-kit/examples");
const examples = readdirSync(root).filter((d) => d.startsWith("cartoon-") && existsSync(path.join(root, d, "video.tsx")));

describe("cartoon examples", () => {
  it("there is at least one", () => expect(examples.length).toBeGreaterThan(0));
  for (const name of examples) {
    const src = readFileSync(path.join(root, name, "video.tsx"), "utf8");
    it(`${name} passes the static check`, () => expect(checkTsx(src).problems).toEqual([]));
    it(`${name} passes the type check`, async () => expect((await typeCheckInThread(src, 90_000)).problems).toEqual([]), 120_000);
    it(`${name} has its beats file`, () => {
      const toon = JSON.parse(readFileSync(path.join(root, name, "toon.json"), "utf8")) as { timeline: { beats: unknown[]; scenes: unknown[] } };
      expect(toon.timeline.beats.length).toBeGreaterThanOrEqual(3);
    });
  }
});
