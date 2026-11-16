import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ToolCheck } from "@/server/core/tool-check";
import { readWorkerToolChecks, saveWorkerToolChecks } from "@/server/db/worker-tool-checks";
import { withTestDb, type TestDb } from "../support/db";

let db: TestDb;
beforeAll(async () => { db = await withTestDb(); });
afterAll(async () => { await db?.stop(); });
beforeEach(() => db.reset());

const ok = (id: ToolCheck["id"]): ToolCheck => ({ id, label: id, ok: true, detail: "fine", fix: null });

describe("worker tool checks", () => {
  it("is null before the worker reports", async () => expect(await readWorkerToolChecks(db.pool)).toBeNull());
  it("saves, reads back, and a second report replaces the first", async () => {
    await saveWorkerToolChecks(db.pool, [ok("docker")]);
    const first = await readWorkerToolChecks(db.pool);
    expect(first?.checks).toEqual([ok("docker")]);
    expect(Date.now() - first!.at.getTime()).toBeLessThan(60_000);
    await saveWorkerToolChecks(db.pool, [ok("docker"), ok("render_image")]);
    expect((await readWorkerToolChecks(db.pool))?.checks).toHaveLength(2);
  });
  it("the app role cannot delete the row", async () => {
    await saveWorkerToolChecks(db.pool, [ok("docker")]);
    await expect(db.pool.query("delete from worker_tool_checks")).rejects.toThrow(/permission denied/);
  });
});
