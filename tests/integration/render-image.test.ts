import { execFileSync, spawnSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

const IMAGE = "ytstudio-render:dev";

const docker = (...args: string[]) => spawnSync("docker", args, { encoding: "utf8" });

beforeAll(() => {
  if (docker("image", "inspect", IMAGE).status === 0) return;
  execFileSync("docker", ["build", "-f", "infra/Dockerfile.render", "-t", IMAGE, "."], { stdio: "pipe" });
}, 900_000);

describe("render image", () => {
  it("image_has_no_python", () => {
    const r = spawnSync("bash", ["infra/check-no-python.sh", IMAGE], { encoding: "utf8" });
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });

  it("image_runs_as_non_root", () => {
    const r = docker("run", "--rm", IMAGE, "id", "-u");
    expect(r.stdout.trim()).toBe("10001");
  });

  it("vendored_fonts_are_registered", () => {
    const r = docker("run", "--rm", IMAGE, "fc-list", ":", "family");
    expect(r.status, r.stderr).toBe(0);
    for (const family of [
      "Noto Sans Devanagari",
      "Noto Sans Tamil",
      "Noto Sans Telugu",
      "Noto Sans Malayalam",
      "Noto Sans Kannada",
      "Space Grotesk",
      "Inter",
      "JetBrains Mono",
      "Spectral",
      "Source Serif 4",
    ]) {
      expect(r.stdout, family).toContain(family);
    }
  });

  it("chrome_headless_shell_is_present_offline", () => {
    const script = `
      const { ensureBrowser } = require("@remotion/renderer");
      ensureBrowser({ browserExecutable: process.env.REMOTION_BROWSER_EXECUTABLE })
        .then((s) => { console.log(JSON.stringify(s)); process.exit(0); })
        .catch((e) => { console.error(e); process.exit(1); });
    `;
    const r = docker(
      "run", "--rm", "--network", "none", "--read-only", "--tmpfs", "/tmp", "-e", "HOME=/tmp",
      IMAGE, "node", "-e", script,
    );
    expect(r.status, r.stderr).toBe(0);
    const exe = docker("run", "--rm", "--network", "none", "--read-only", IMAGE, "sh", "-c", '"$REMOTION_BROWSER_EXECUTABLE" --version');
    expect(exe.status, exe.stderr).toBe(0);
    expect(exe.stdout).toMatch(/Chrome|Chromium/i);
  });
});
