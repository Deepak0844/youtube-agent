import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { StageContext } from "@/server/core/stage-handler";
import { createFakeImage } from "@/server/providers/media/fake";
import { createFakeUploader } from "@/server/providers/uploader/fake";
import { createFakeVoice } from "@/server/providers/voice/fake";
import { withTestDb, type TestDb } from "../support/db";

let db: TestDb;
let dir: string;
beforeAll(async () => {
  db = await withTestDb();
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), "fakes-int-")));
});
afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  await db.stop();
});
beforeEach(async () => {
  await db.reset();
  await db.ownerPool.query("truncate fake_provider_calls");
});

const ctx = (id: string): StageContext => ({ claim: { stageRunId: id }, attemptDir: dir, paid: async (_s: unknown, f: (k: string, s: AbortSignal) => Promise<{ result: unknown }>) => (await f("k", new AbortController().signal)).result, signal: new AbortController().signal }) as unknown as StageContext;

describe("fake call counts agree with the fake_provider_calls table", () => {
  it("voice, image and uploader count the same in memory and in Postgres", async () => {
    const voice = createFakeVoice({ pool: db.pool });
    const image = createFakeImage({ pool: db.pool });
    const up = createFakeUploader({ pool: db.pool });
    const sig = new AbortController().signal;

    await voice.synthesise(ctx("s1"), { text: "a b c", lang: "en", voice: "v" });
    await voice.synthesise(ctx("s1"), { text: "a b c", lang: "en", voice: "v" });
    await image.generate(ctx("s2"), { prompt: "p", aspect: "1:1", model: "fake", budgetScopes: ["v"] });
    await up.upload("u1", async () => {}, sig);

    for (const [fake, key, n] of [
      [voice, "fake:voice:s1", 2],
      [image, "fake:image:s2", 1],
      [up, "fake:upload:u1", 1],
    ] as const) {
      expect(fake.calls.get(key)).toBe(n);
      expect(await fake.dbCalls(key)).toBe(n);
    }
    const { rows } = await db.ownerPool.query("select count(*)::int as n from fake_provider_calls");
    expect(rows[0].n).toBe(4);
    expect(voice.totalCalls() + image.totalCalls() + up.totalCalls()).toBe(4);
  });
});
