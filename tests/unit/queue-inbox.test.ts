import { describe, expect, it } from "vitest";
import { parseQueueTab, pickItem } from "@/server/core/queue-inbox";

const items = [{ videoId: "a" }, { videoId: "b" }, { videoId: "c" }];

describe("queue inbox", () => {
  it("picks the item named in the URL", () => {
    expect(pickItem(items, "b")).toEqual({ videoId: "b" });
  });
  it("no item in the URL: the oldest (first) is opened", () => {
    expect(pickItem(items, undefined)).toEqual({ videoId: "a" });
    expect(pickItem(items, "")).toEqual({ videoId: "a" });
  });
  it("an item that is no longer waiting opens NOTHING (never another video's gate in its place)", () => {
    expect(pickItem(items, "zzz")).toBeNull();
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
