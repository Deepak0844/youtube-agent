import { describe, expect, it } from "vitest";
import { parseQueueTab, pickItem } from "@/server/core/queue-inbox";

const items = [{ videoId: "a" }, { videoId: "b" }, { videoId: "c" }];

describe("queue inbox", () => {
  it("picks the item named in the URL", () => {
    expect(pickItem(items, "b")).toEqual({ videoId: "b" });
  });
  it("an unknown or missing item falls back to the oldest (first)", () => {
    expect(pickItem(items, "zzz")).toEqual({ videoId: "a" });
    expect(pickItem(items, undefined)).toEqual({ videoId: "a" });
  });
  it("an empty list has nothing selected", () => {
    expect(pickItem([], "a")).toBeNull();
  });
  it("tabs: needs (default), running, failed; anything else is needs", () => {
    expect(parseQueueTab("running")).toBe("running");
    expect(parseQueueTab("failed")).toBe("failed");
    expect(parseQueueTab("x")).toBe("needs");
    expect(parseQueueTab(undefined)).toBe("needs");
  });
});
