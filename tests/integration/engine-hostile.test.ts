import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildEngineConfig } from "@/server/core/engine-config";
import { createVideoRow } from "@/server/db/videos";
import { runEngine, type EngineDeps } from "@/server/engine/run";
import { withTestDb, type TestDb } from "../support/db";

// A hostile run against the walls the app owns (ADR 0015). Claude Code's own permission rules (no shell, no web in a build run,
// writes only in work/, reads only in work/) were probed against the real CLI and are recorded in the ADR; here a scripted fake
// does the forbidden things directly, and the after-run check must fail every one of them.

const FAKE = path.resolve("tests/fixtures/fake-claude.mjs");
let db: TestDb;
let root: string;
let seeds: string;
beforeAll(async () => {
  db = await withTestDb();
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "eng-hostile-")));
  seeds = realpathSync(mkdtempSync(path.join(tmpdir(), "eng-seeds-")));
  mkdirSync(path.join(seeds, "skills", "make-short"), { recursive: true });
  writeFileSync(path.join(seeds, "skills", "make-short", "SKILL.md"), "---\nname: make-short\n---\nmake it");
  mkdirSync(path.join(seeds, "brand"));
  writeFileSync(path.join(seeds, "brand", "brand.md"), "colours");
});
afterAll(async () => {
  rmSync(root, { recursive: true, force: true });
  rmSync(seeds, { recursive: true, force: true });
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
});

const deps = (): EngineDeps => ({
  db: db.pool, root, config: { ...buildEngineConfig(new Map()).engine, enabled: true }, command: { cmd: process.execPath, prefix: [FAKE] },
  seeds: { skillsDir: path.join(seeds, "skills"), refDirs: [{ from: path.join(seeds, "brand"), to: "brand" }] }, tools: () => [],
});
const run = async (mode: string) => {
  const v = (await createVideoRow(db.pool, { format: "short", kind: "tsx", language: "en", topic: "hostile" })).id;
  return runEngine(deps(), { videoId: v, stageRunId: "0190f3a2-7c1e-7a55-9d3b-2f6c8a1b4e91", kind: "build", prompt: JSON.stringify({ mode }), long: false, signal: new AbortController().signal });
};

describe("hostile engine runs", () => {
  it.each([
    ["outside", /outside the work folder: escaped\.txt/],
    ["symlink", /link: work\/hosts/],
    ["dotclaude", /the skills folder \(\.claude\) changed: work\/\.claude\/skills\/evil/],
    ["ref", /reference file changed: work\/ref\/brand\/brand\.md/],
    ["flood", /more than 5000 files/],
  ])("%s fails the run with a plain sentence", async (mode, why) => {
    const r = await run(mode);
    expect(r.ok).toBe(false);
    if (r.ok || r.limit) throw new Error("expected a failure");
    expect(r.message).toMatch(/^The run broke its folder rules \(/);
    expect(r.message).toMatch(why);
  }, 30_000);

  it("a normal run with the same seeds passes", async () => {
    expect((await run("ok")).ok).toBe(true);
  });
});
