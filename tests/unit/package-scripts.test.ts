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
  it("start:container binds all interfaces and is the only script that does", () => {
    expect(scripts["start:container"]).toBe("next start -H 0.0.0.0");
    for (const [name, cmd] of Object.entries(scripts)) if (name !== "start:container") expect(cmd).not.toContain("0.0.0.0");
  });
  it("worker:container runs the worker without an env file", () => {
    expect(scripts["worker:container"]).toBe("tsx src/worker/index.ts");
  });
  it("auth_purge_script_exists", () => {
    expect(scripts["auth:purge"]).toBe("tsx scripts/auth-purge.ts");
  });
});
