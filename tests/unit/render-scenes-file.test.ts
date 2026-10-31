import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { KnownFailure } from "@/server/core/paid-call";
import { readScenesFile } from "@/worker/stages/render";

const dir = mkdtempSync(path.join(tmpdir(), "scenes-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const put = (name: string, body: string) => (writeFileSync(path.join(dir, name), body), path.join(dir, name));

describe("readScenesFile", () => {
  it("reads and validates a good file", async () => {
    const f = put("ok.json", JSON.stringify({ version: 1, scenes: [{ id: "s1", beat: "b1", kind: "terminal", startMs: 0, durationMs: 2000, lines: [{ text: "ls" }] }] }));
    expect((await readScenesFile(f)).scenes).toHaveLength(1);
  });
  it("refuses an oversized, broken or invalid file with a plain known failure", async () => {
    await expect(readScenesFile(put("big.json", " ".repeat(1024 * 1024 + 1)))).rejects.toThrow(/too big/);
    await expect(readScenesFile(put("bad.json", "{"))).rejects.toThrow(KnownFailure);
    await expect(readScenesFile(put("inv.json", JSON.stringify({ version: 1, scenes: [] })))).rejects.toThrow(/scenes_invalid/);
  });
});
