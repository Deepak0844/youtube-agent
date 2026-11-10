import { describe, expect, it } from "vitest";
import { joinArgs, joinListText } from "@/server/render/mix";

describe("joining the chapter clips", () => {
  it("lists plain clip names in order, one per line", () => {
    expect(joinListText(["chapter-01.mp4", "chapter-02.mp4"])).toBe("file 'chapter-01.mp4'\nfile 'chapter-02.mp4'\n");
  });
  it("refuses an empty list and any name that could break out of the list or leave the folder", () => {
    for (const bad of [[], ["a'b.mp4"], ["../x.mp4"], ["/etc/passwd.mp4"], ["a b.mp4"], ["chapter-01.mov"], ["a\n.mp4"], [".mp4"], ["x".repeat(50) + ".mp4"]]) {
      expect(() => joinListText(bad), JSON.stringify(bad)).toThrow(/file name/);
    }
  });
  it("copies the streams (no re-encode), allows only the file protocol and reads no stdin", () => {
    const a = joinArgs("chapters.txt", "/x/render.mp4");
    expect(a).toEqual(["-nostdin", "-hide_banner", "-y", "-f", "concat", "-safe", "1", "-protocol_whitelist", "file", "-i", "chapters.txt", "-c", "copy", "-movflags", "+faststart", "/x/render.mp4"]);
  });
});
