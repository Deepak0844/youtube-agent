import { describe, expect, it } from "vitest";
import { createDockerRunner, selectRunner, usesRenderService, type ContainerRunner } from "@/server/providers/renderer/container-runner";

// Native keeps docker; compose points the worker at the render service. Half a configuration is an error, never a silent fallback.
const base = { docker: { runChild: async () => ({ code: 0, signal: null, truncated: false, timedOut: false, aborted: false }) }, storageRoot: "/data" };
const same = (a: ContainerRunner, b: ContainerRunner) => Object.keys(a).sort().join() === Object.keys(b).sort().join();

describe("usesRenderService / selectRunner", () => {
  it("neither variable: the docker adapter, as before", () => {
    expect(usesRenderService({})).toBe(false);
    expect(usesRenderService({ RENDER_RUNNER_URL: "", RENDER_RUNNER_TOKEN: " " })).toBe(false);
    expect(same(selectRunner({}, base), createDockerRunner(base.docker))).toBe(true);
  });
  it("both: the service adapter", () => {
    const env = { RENDER_RUNNER_URL: "http://render-runner:4100", RENDER_RUNNER_TOKEN: "t".repeat(32) };
    expect(usesRenderService(env)).toBe(true);
    expect(selectRunner(env, base).run).toBeTypeOf("function");
  });
  it("only one of them is a configuration error that says so", () => {
    for (const env of [{ RENDER_RUNNER_URL: "http://x:4100" }, { RENDER_RUNNER_TOKEN: "t".repeat(32) }]) {
      expect(() => selectRunner(env, base)).toThrow("RENDER_RUNNER_URL and RENDER_RUNNER_TOKEN must be set together");
      expect(() => usesRenderService(env)).toThrow("RENDER_RUNNER_URL and RENDER_RUNNER_TOKEN must be set together");
    }
  });
  it("a service URL that is not http(s) is refused", () => {
    expect(() => selectRunner({ RENDER_RUNNER_URL: "ftp://x", RENDER_RUNNER_TOKEN: "t".repeat(32) }, base)).toThrow("RENDER_RUNNER_URL must be an http(s) address");
  });
});
