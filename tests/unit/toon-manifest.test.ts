import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const manifest = JSON.parse(readFileSync(path.join(root, "engine-kit/cartoon-shorts/MANIFEST.json"), "utf8")) as {
  upstream: string;
  commit: string;
  files: { path: string; sha256: string; patched: boolean }[];
};
const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

describe("cartoon-shorts manifest", () => {
  it("every manifest file exists and unpatched files keep the upstream hash", () => {
    expect(manifest.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(manifest.files.length).toBeGreaterThan(5);
    for (const f of manifest.files) {
      const p = path.join(root, f.path);
      expect(existsSync(p), f.path).toBe(true);
      if (!f.patched) expect(sha(p), f.path).toBe(f.sha256);
    }
  });
  it("every cartoon font has its OFL text", () => {
    for (const n of ["Anton", "Bangers", "Nunito"]) expect(existsSync(path.join(root, `infra/render/fonts/OFL-${n}.txt`)), n).toBe(true);
  });
  it("the upstream MIT licence travels with the copies", () => {
    expect(readFileSync(path.join(root, "engine-kit/cartoon-shorts/LICENSE"), "utf8")).toContain("MIT License");
  });
});
