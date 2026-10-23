import { execFileSync, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const check = (...images: string[]) =>
  spawnSync("bash", ["infra/check-no-python.sh", ...images], { encoding: "utf8" });

// Mirrors what `apt install python3` leaves on Debian: a versioned binary plus a
// python3 symlink to it, and no plain `python`.
function buildImage(tag: string, run: string) {
  execFileSync("docker", ["build", "-q", "-t", tag, "-"], {
    input: `FROM alpine:3.20\nRUN ${run}\n`,
  });
}

describe("no-python image check", () => {
  it("passes an image without python", () => {
    expect(check("alpine:3.20").status).toBe(0);
  });

  it("fails an image with python and names it", () => {
    const r = check("python:3.12-slim");
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain("python");
  });

  it("fails an image where python3 is only a symlink to python3.11", () => {
    buildImage("ytstudio-test-pysym", "touch /usr/bin/python3.11 && chmod +x /usr/bin/python3.11 && ln -s python3.11 /usr/bin/python3");
    const r = check("ytstudio-test-pysym");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("usr/bin/python3");
  });

  it("fails an image with only a versioned python3.11 binary", () => {
    buildImage("ytstudio-test-pyver", "touch /usr/bin/python3.11 && chmod +x /usr/bin/python3.11");
    expect(check("ytstudio-test-pyver").status).toBe(1);
  });

  it("fails closed when the image cannot be read", () => {
    expect(check("ytstudio-does-not-exist:none").status).toBe(2);
  });
});
