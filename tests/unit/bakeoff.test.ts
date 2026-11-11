import { describe, expect, it } from "vitest";
import { cheapest, gridArgs, gridProblem, gridShape, labelLines, LABEL_HEIGHT, MAX_PANELS, PANEL, type Panel } from "@/server/core/bakeoff";

const p = (label: string, cost: number | null, file = `${label}.mp4`): Panel => ({ file, label, costMicroUsd: cost });

describe("gridProblem", () => {
  it("wants two to six clips", () => {
    expect(gridProblem([p("a", 1)])).toMatch(/at least 2/);
    expect(gridProblem(Array.from({ length: MAX_PANELS + 1 }, (_, i) => p(`m${i}`, 1)))).toMatch(/at most 6/);
    expect(gridProblem([p("a", 1), p("b", null)])).toBeNull();
  });
  it("refuses other files, odd labels and bad costs", () => {
    expect(gridProblem([p("a", 1, "a.exe"), p("b", 1)])).toMatch(/MP4 or MOV/);
    expect(gridProblem([p("a;rm -rf", 1), p("b", 1)])).toMatch(/label/);
    expect(gridProblem([p("x".repeat(61), 1), p("b", 1)])).toMatch(/label/);
    expect(gridProblem([p("a", -1), p("b", 1)])).toMatch(/cost/);
    expect(gridProblem([p("a", 1.5), p("b", 1)])).toMatch(/cost/);
    expect(gridProblem([p("a", Number.NaN), p("b", 1)])).toMatch(/cost/);
  });
});

describe("layout and labels", () => {
  it("is two across up to four clips, then three across", () => {
    expect([2, 3, 4, 5, 6].map(gridShape)).toEqual([{ cols: 2, rows: 1 }, { cols: 2, rows: 2 }, { cols: 2, rows: 2 }, { cols: 3, rows: 2 }, { cols: 3, rows: 2 }]);
  });
  it("shows the real cost, or says it is not recorded (never free), and marks only a known cheapest", () => {
    expect(labelLines(p("Kling 4.0", 550_000))).toEqual(["Kling 4.0", "$0.55 for this clip"]);
    expect(labelLines(p("Veo", null))).toEqual(["Veo", "cost not recorded"]);
    expect(cheapest([p("a", 500), p("b", 300), p("c", null), p("d", 300)])).toEqual([1, 3]);
    expect(cheapest([p("a", null), p("b", null)])).toEqual([]);
  });
});

describe("gridArgs", () => {
  const panels = [p("a", 1), p("b", 2), p("c", null)];
  const labels = ["l0.png", "l1.png", "l2.png"];
  const args = gridArgs(panels, labels, "out.mp4");
  const graph = args[args.indexOf("-filter_complex") + 1]!;
  it("scales to fit without stretching, overlays each label on the bottom strip and stacks the panels in a 2-column layout", () => {
    expect(graph).toContain(`scale=${PANEL.width}:${PANEL.height}:force_original_aspect_ratio=decrease`);
    expect(graph).toContain(`overlay=0:${PANEL.height - LABEL_HEIGHT}:format=auto:shortest=1`); // the endless label image must not keep the video running
    expect(graph).toContain(`xstack=inputs=3:layout=0_0|${PANEL.width}_0|0_${PANEL.height}`);
    expect(graph).toContain("shortest=1");
  });
  it("takes the clips first, then the labels, drops audio and writes only the output", () => {
    const inputs = args.flatMap((a, i) => (a === "-i" ? [args[i + 1]!] : []));
    expect(inputs).toEqual(["a.mp4", "b.mp4", "c.mp4", "l0.png", "l1.png", "l2.png"]);
    expect(args).toContain("-an");
    expect(args.at(-1)).toBe("out.mp4");
  });
  it("refuses bad panels or a missing label before building anything", () => {
    expect(() => gridArgs([p("a", 1)], ["x"], "o.mp4")).toThrow(RangeError);
    expect(() => gridArgs(panels, ["only-one.png"], "o.mp4")).toThrow(RangeError);
  });
});
