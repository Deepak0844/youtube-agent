import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import manifest from "@/app/manifest";

describe("PWA manifest", () => {
  const m = manifest();
  it("is installable: standalone, a start url, a 192 and a 512 icon", () => {
    expect(m.display).toBe("standalone");
    expect(m.start_url).toBe("/");
    const sizes = (m.icons ?? []).map((i) => i.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
  });
  it("lists a maskable icon", () => {
    expect((m.icons ?? []).some((i) => i.purpose === "maskable")).toBe(true);
  });
  it("points at icon files that exist in public/", () => {
    for (const i of m.icons ?? []) expect(existsSync(`public${i.src}`), i.src).toBe(true);
  });
});
