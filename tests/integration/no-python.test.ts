import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const check = (...images: string[]) =>
  spawnSync("bash", ["infra/check-no-python.sh", ...images], { encoding: "utf8" });

describe("no-python image check", () => {
  it("passes an image without python", () => {
    expect(check("alpine:3.20").status).toBe(0);
  });

  it("fails an image with python and names it", () => {
    const r = check("python:3.12-slim");
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain("python");
  });
});
