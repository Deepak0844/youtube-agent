import { describe, expect, it } from "vitest";
import { assertDockerUp, parseServerVersion } from "../support/infra";

describe("parseServerVersion", () => {
  it.each([["27.3.1\n", "27.3.1"], ["  28.0.4  ", "28.0.4"]])("accepts %j", (out, v) => {
    expect(parseServerVersion(out)).toBe(v);
  });
  it.each([[""], ["\n"], ["   "], ["<no value>"], ["failed to connect to the docker API"], ["a b"]])(
    "rejects %j (fail closed)",
    (out) => {
      expect(() => parseServerVersion(out)).toThrow("Docker engine not reachable. Start OrbStack and retry.");
    },
  );
});

// A busy CI runner can answer `docker info` late (the e2e global setup failed on develop with the 4 s limit). A daemon that answers
// late is retried; one that is not there fails at once (the integration smoke test requires failing fast).
describe("assertDockerUp", () => {
  const timedOut = () => Object.assign(new Error("timed out"), { killed: true, signal: "SIGTERM" });
  const refused = () => Object.assign(new Error("cannot connect"), { code: 1 });
  const seq = (...steps: Array<() => Error | string>) => {
    let n = 0;
    const calls = { n: 0 };
    const exec = async () => {
      calls.n = ++n;
      const r = steps[Math.min(n - 1, steps.length - 1)]!();
      if (r instanceof Error) throw r;
      return { stdout: r };
    };
    return { exec, calls };
  };

  it("passes when the first answer is a version", async () => {
    const { exec, calls } = seq(() => "27.3.1\n");
    await expect(assertDockerUp(exec)).resolves.toBeUndefined();
    expect(calls.n).toBe(1);
  });
  it("retries a daemon that answers too late, then passes", async () => {
    const { exec, calls } = seq(timedOut, timedOut, () => "27.3.1\n");
    await expect(assertDockerUp(exec)).resolves.toBeUndefined();
    expect(calls.n).toBe(3);
  });
  it("gives up after three late answers", async () => {
    const { exec, calls } = seq(timedOut);
    await expect(assertDockerUp(exec)).rejects.toThrow("Docker engine not reachable");
    expect(calls.n).toBe(3);
  });
  it("fails at once, without retrying, when there is no daemon", async () => {
    const { exec, calls } = seq(refused);
    await expect(assertDockerUp(exec)).rejects.toThrow("Docker engine not reachable");
    expect(calls.n).toBe(1);
  });
  it("still refuses a non-version answer", async () => {
    const { exec } = seq(() => "<no value>");
    await expect(assertDockerUp(exec)).rejects.toThrow("Docker engine not reachable");
  });
});
