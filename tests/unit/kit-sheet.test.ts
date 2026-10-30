import { describe, expect, it } from "vitest";
import { registryIds, sheetHtml } from "../../scripts/kit-sheet-html.mjs";

describe("kit sheet helpers", () => {
  it("reads ids from registry text", () => {
    expect(registryIds('  { id: "kit-a", component: A },\n  { id: "kit-b-1", component: B },\n{ id: "x", y: 1 }')).toEqual(["kit-a", "kit-b-1"]);
  });
  it("captions every id", () => {
    const html = sheetHtml(["kit-a", "kit-b"], 2);
    expect(html).toContain("<figcaption>kit-a</figcaption>");
    expect(html).toContain("<figcaption>kit-b</figcaption>");
  });
});
