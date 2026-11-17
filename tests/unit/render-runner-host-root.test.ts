import { describe, expect, it } from "vitest";
import { hostRootChecker } from "../../infra/render-runner/docker";

const cfg = { root: "/data", hostRoot: "/Users/me/data", image: "sha256:" + "c".repeat(64) };

describe("hostRootChecker", () => {
  it("passes when the test container sees the same top-level names, and remembers the answer for 10 minutes", async () => {
    let probes = 0;
    let t = 0;
    const check = hostRootChecker(cfg, async () => ["videos", "audio"], async () => { probes++; return "audio\nvideos\n"; }, () => t);
    expect(await check()).toBeNull();
    t = 599_000;
    expect(await check()).toBeNull();
    expect(probes).toBe(1);
    t = 601_000;
    await check();
    expect(probes).toBe(2);
  });
  it("refuses, naming the setting, when the host folder shows different files, and asks again every time", async () => {
    let probes = 0;
    const check = hostRootChecker(cfg, async () => ["videos", "audio"], async () => { probes++; return "other\n"; });
    expect(await check()).toMatch(/HOST_STORAGE_ROOT \(\/Users\/me\/data\) is not the folder mounted at \/data/);
    await check();
    expect(probes).toBe(2);
  });
  it("mounts the host root read-only with no network", async () => {
    let args: string[] = [];
    await hostRootChecker(cfg, async () => [], async (a) => { args = a; return ""; })();
    expect(args).toEqual(expect.arrayContaining(["--network", "none", "--read-only", "-v", "/Users/me/data:/probe:ro"]));
  });
  it("says the check could not run when the test container does not start", async () => {
    expect(await hostRootChecker(cfg, async () => ["videos"], async () => { throw new Error("no docker"); })()).toMatch(/could not be checked/);
  });
});
