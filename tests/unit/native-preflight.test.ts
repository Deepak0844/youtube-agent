import { describe, expect, it } from "vitest";
import { checkNativeRenderReady, MIN_FREE_BYTES, REMOTION_PIN, type PreflightDeps } from "@/server/providers/renderer/native-preflight";

const ok: PreflightDeps = {
  platform: "darwin",
  repoRoot: "/nonexistent-repo",
  storageRoot: "/nonexistent-repo",
  executable: () => true,
  moduleVersion: () => REMOTION_PIN,
  findChrome: () => "/nonexistent-repo/node_modules/.remotion/chrome-headless-shell/mac/chrome-headless-shell",
  freeBytes: () => MIN_FREE_BYTES + 1,
};
const check = (o: Partial<PreflightDeps> = {}) => checkNativeRenderReady({ ...ok, ...o });

describe("checkNativeRenderReady", () => {
  it("is ready when everything is there, and says where the Chrome shell folder is", async () => {
    const r = await check();
    expect(r.ready).toBe(true);
    expect(r.message).toBe("Ready: this Mac can render 3D videos natively.");
    expect(r.chromeDir).toBe("/nonexistent-repo/node_modules/.remotion/chrome-headless-shell/mac");
  });

  it("not on a Mac", async () => {
    const r = await check({ platform: "linux" });
    expect(r).toMatchObject({ ready: false, chromeDir: null });
    expect(r.message).toBe("Not ready: native 3D rendering works only on a Mac.");
  });

  it("sandbox-exec missing", async () => {
    const r = await check({ executable: () => false });
    expect(r.ready).toBe(false);
    expect(r.message).toMatch(/sandbox-exec\) is missing, so the render could not be locked down/);
  });

  it("a missing or wrong-version Remotion package, named", async () => {
    const r = await check({ moduleVersion: (n) => (n === "@remotion/renderer" ? null : "4.0.1") });
    expect(r.ready).toBe(false);
    expect(r.message).toContain("@remotion/renderer is not installed");
    expect(r.message).toContain(`@remotion/bundler is version 4.0.1 but must be ${REMOTION_PIN}`);
  });

  it("no Chrome shell: tells the owner the one command to run, and the worker downloads nothing", async () => {
    const r = await check({ findChrome: () => null });
    expect(r.ready).toBe(false);
    expect(r.message).toContain("the Chrome headless shell is not downloaded yet");
    expect(r.message).toContain("npx remotion browser ensure");
  });

  it("low disk", async () => {
    const r = await check({ freeBytes: () => 1024 });
    expect(r.ready).toBe(false);
    expect(r.message).toContain("less than 5 GB of disk is free");
  });

  it("an unknown disk size does not block", async () => {
    expect((await check({ freeBytes: () => null })).ready).toBe(true);
  });

  it("lists every problem at once", async () => {
    const r = await check({ executable: () => false, findChrome: () => null, freeBytes: () => 0 });
    expect(r.message.split(";")).toHaveLength(3);
  });

  it("never throws, even when nothing exists (real file checks on a missing repo)", async () => {
    const r = await checkNativeRenderReady({ platform: "darwin", repoRoot: "/nonexistent-repo", storageRoot: "/nonexistent-repo" });
    expect(r.ready).toBe(false);
    expect(r.message).toContain("@remotion/renderer is not installed");
  });
});
