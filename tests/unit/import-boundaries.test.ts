import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// Cheap structural guards; the full import-boundary rules come with the cleanup branch.
describe("import boundaries", () => {
  it("src/app never imports from src/worker", () => {
    const hits = execSync("grep -rl 'from \"@/worker' src/app || true", { encoding: "utf8" }).trim();
    expect(hits).toBe("");
  });
});
