import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("package.json scripts", () => {
  const scripts = (JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> }).scripts;
  it.each(["dev", "start", "dev:all"])("%s_binds_next_to_loopback", (name) => {
    const cmd = scripts[name] ?? "";
    expect(cmd).toMatch(/next (dev|start)/);
    // every `next dev|start` invocation in the script carries -H 127.0.0.1
    const calls = cmd.match(/next (?:dev|start)[^"&|]*/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c).toContain("-H 127.0.0.1");
  });
  it("auth_purge_script_exists", () => {
    expect(scripts["auth:purge"]).toBe("tsx scripts/auth-purge.ts");
  });
});
