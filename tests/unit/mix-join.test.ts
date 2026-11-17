import { describe, expect, it } from "vitest";
import { joinArgs, joinFadeArgs, joinListText } from "@/server/render/mix";

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

  it("fade join: dips at inner seams only, keeps the total length, same name rules", () => {
    const a = joinFadeArgs(["c1.mp4", "c2.mp4", "c3.mp4"], [10, 20, 5], 0.2, "/x/render.mp4");
    const g = a[a.indexOf("-filter_complex") + 1]!;
    expect(g).toContain("[0:v]fade=t=out:st=9.800:d=0.200[v0]");
    expect(g).toContain("[1:v]fade=t=in:st=0:d=0.200,fade=t=out:st=19.800:d=0.200[v1]");
    expect(g).toContain("[2:v]fade=t=in:st=0:d=0.200[v2]");
    expect(g).toContain("concat=n=3:v=1:a=0[outv]");
    expect(a).toContain("-nostdin");
    expect(() => joinFadeArgs(["../x.mp4"], [1], 0.2, "o.mp4")).toThrow(/file name/);
    expect(() => joinFadeArgs(["a.mp4", "b.mp4"], [1], 0.2, "o.mp4")).toThrow(/lengths/);
  });
  it("fade join: a very short clip gets a shorter fade", () => {
    const g = joinFadeArgs(["a.mp4", "b.mp4"], [0.3, 5], 0.2, "o.mp4");
    expect(g[g.indexOf("-filter_complex") + 1]).toContain("fade=t=out:st=0.200:d=0.100");
  });
});
