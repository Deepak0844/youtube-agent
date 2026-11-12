import { describe, expect, it } from "vitest";
import { bellItem } from "@/server/core/notify-view";

const row = (o: Partial<Parameters<typeof bellItem>[0]> = {}) => ({ id: "1", at: new Date("2026-11-06T08:19:00Z"), event: "video_failed", videoId: "v1", title: "Video failed", text: "draft", readAt: null, ...o });

describe("bellItem", () => {
  it("a failure is a problem, names the step in words and links to its video", () => {
    expect(bellItem(row())).toEqual({ group: "problems", title: "Video failed", detail: "Step: Draft", href: "/videos/v1", unread: true });
  });
  it("an internal step id becomes its label", () => {
    expect(bellItem(row({ text: "scene3d_author" })).detail).toBe("Step: 3D scene code");
  });
  it("free text stays as it is", () => {
    expect(bellItem(row({ event: "breaker_hit", text: 'Stage "draft" is paused.' })).detail).toBe('Stage "draft" is paused.');
  });
  it("needs-you events link to the queue item; read ones are not unread", () => {
    const b = bellItem(row({ event: "script_review", text: null, readAt: new Date() }));
    expect(b).toMatchObject({ group: "needs_you", detail: null, href: "/queue?item=v1", unread: false });
  });
  it("no video: no link; unknown event counts as a problem", () => {
    expect(bellItem(row({ event: "something_new", videoId: null }))).toMatchObject({ group: "problems", href: null });
  });
});
