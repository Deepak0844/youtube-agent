import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

let size = { width: 1920, height: 1080 };
vi.mock("remotion", () => ({ useCurrentFrame: () => 30, useVideoConfig: () => ({ fps: 30, ...size }) }));

const words = [{ word: "hello", startS: 0, endS: 2 }];

async function bottomOf(): Promise<string> {
  const { TsxCaptions } = await import("../../remotion/kit/TsxCaptions");
  const html = renderToStaticMarkup(React.createElement(TsxCaptions, { words }));
  return /bottom:(\d+)px/.exec(html)![1]!;
}

describe("TsxCaptions position", () => {
  it("landscape captions end inside the low band (bottom 40 of 1080); portrait keeps 150", async () => {
    expect(await bottomOf()).toBe("40");
    size = { width: 1080, height: 1920 };
    expect(await bottomOf()).toBe("150");
  });
});
