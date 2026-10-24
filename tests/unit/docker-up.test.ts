import { describe, expect, it } from "vitest";
import { parseServerVersion } from "../support/infra";

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
