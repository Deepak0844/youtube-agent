import { describe, expect, it } from "vitest";
import { typeCheckInThread } from "@/server/providers/renderer/tsx-render";

// The real TypeScript compiler in a worker thread, against the app's installed react + remotion typings.
const GOOD = `import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
export default function Scene({ title }: { title: string }) {
  const frame = useCurrentFrame();
  return <AbsoluteFill style={{ opacity: interpolate(frame, [0, 30], [0, 1]) }}>{title}</AbsoluteFill>;
}
export const meta = { durationInFrames: 90, fps: 30, width: 1080, height: 1920 };
`;

describe("typeCheckInThread", () => {
  it("passes a typed scene and reports type errors, unknown modules and Node globals", async () => {
    expect(await typeCheckInThread(GOOD, 60_000)).toEqual({ ok: true, problems: [] });
    const bad = `import { AbsoluteFill, useCurrentFrame } from "remotion";
import fs from "fs";
export default function Scene() {
  const frame: string = useCurrentFrame();
  const env = process.env.X;
  return <AbsoluteFill nope={1}>{frame}{env}{String(fs)}</AbsoluteFill>;
}
`;
    const r = await typeCheckInThread(bad, 60_000);
    expect(r.ok).toBe(false);
    const text = r.problems.join("\n");
    expect(text).toMatch(/line 2: .*'fs'/);
    expect(text).toMatch(/line 4: .*not assignable/);
    expect(text).toMatch(/line 5: .*'process'/);
    expect(text).toMatch(/line 6: .*nope/);
  }, 120_000);

  it("a run over its time limit is stopped and fails closed", async () => {
    const r = await typeCheckInThread(GOOD, 1);
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatch(/took longer/);
  });
});
