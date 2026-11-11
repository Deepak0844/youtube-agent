import { describe, expect, it } from "vitest";
import { PAGE_SIZES, clampPage, pageHref, pageLabel, pageLinks, parsePage, parseSort } from "@/server/core/paging";

describe("parsePage", () => {
  it("defaults to page 1 of 25", () => {
    expect(parsePage({})).toEqual({ page: 1, size: 25, limit: 25, offset: 0 });
  });
  it.each([["0"], ["abc"], ["-3"], ["1.5"], [["2", "3"]]])("bad page %j becomes 1", (page) => {
    expect(parsePage({ page }).page).toBe(1);
  });
  it("a size that is not offered snaps to 25", () => {
    expect(parsePage({ size: "7" }).size).toBe(25);
  });
  it("offered sizes are kept and set the offset", () => {
    expect(PAGE_SIZES).toEqual([25, 50, 100]);
    expect(parsePage({ page: "3", size: "50" })).toEqual({ page: 3, size: 50, limit: 50, offset: 100 });
  });
});

describe("clampPage", () => {
  it("a page past the end becomes the last page", () => {
    expect(clampPage(parsePage({ page: "99" }), 30)).toEqual({ page: 2, size: 25, limit: 25, offset: 25 });
  });
  it("no rows means page 1", () => {
    expect(clampPage(parsePage({ page: "3" }), 0).page).toBe(1);
  });
  it("a page inside the range is unchanged", () => {
    expect(clampPage(parsePage({ page: "2" }), 60).page).toBe(2);
  });
});

describe("pageLabel", () => {
  it("first page", () => expect(pageLabel(1, 25, 312)).toBe("1–25 of 312"));
  it("last page", () => expect(pageLabel(13, 25, 312)).toBe("301–312 of 312"));
  it("empty", () => expect(pageLabel(1, 25, 0)).toBe("0 of 0"));
});

describe("pageLinks", () => {
  it("middle page", () => expect(pageLinks(5, 10)).toEqual([1, "…", 4, 5, 6, "…", 10]));
  it("one page", () => expect(pageLinks(1, 1)).toEqual([1]));
  it("near the start has no leading gap", () => expect(pageLinks(2, 10)).toEqual([1, 2, 3, "…", 10]));
  it("a gap of one page shows the page, not dots", () => expect(pageLinks(4, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]));
});

describe("pageHref", () => {
  it("changing a filter drops the page number", () => {
    const h = pageHref("/videos", { page: "3", kind: "ai" }, { format: "short" });
    expect(h).toBe("/videos?kind=ai&format=short");
  });
  it("changing the page keeps the filters", () => {
    expect(pageHref("/videos", { page: "3", kind: "ai" }, { page: 4 })).toBe("/videos?page=4&kind=ai");
  });
  it("page 1 and size 25 are left out of the link", () => {
    expect(pageHref("/videos", { page: "3", size: "25" }, { page: 1 })).toBe("/videos");
  });
  it("undefined removes a key", () => {
    expect(pageHref("/videos", { kind: "ai" }, { kind: undefined })).toBe("/videos");
  });
});

describe("parseSort", () => {
  const cols = ["created", "title"] as const;
  it("known column and direction", () => expect(parseSort({ sort: "title", dir: "asc" }, cols, "created")).toEqual({ sort: "title", dir: "asc" }));
  it("unknown column falls back, newest first", () => expect(parseSort({ sort: "drop table", dir: "x" }, cols, "created")).toEqual({ sort: "created", dir: "desc" }));
});
