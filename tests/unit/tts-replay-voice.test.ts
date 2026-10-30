import { mkdtemp, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { KnownFailure } from "@/server/core/paid-call";
import { guardPaidLineVoice } from "@/worker/stages/tts";

describe("guardPaidLineVoice", () => {
  it("lets a retry with the same voice route through", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "tts-guard-"));
    await guardPaidLineVoice(dir, 0, "key-a");
    await expect(guardPaidLineVoice(dir, 0, "key-a")).resolves.toBeUndefined();
  });

  it("refuses a retry after the voice route changed, keeping the first mark so the old audio stays under its own key", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "tts-guard-"));
    await guardPaidLineVoice(dir, 0, "key-a");
    await expect(guardPaidLineVoice(dir, 0, "key-b")).rejects.toBeInstanceOf(KnownFailure);
    const [mark] = await readdir(dir);
    expect(await readFile(path.join(dir, mark!), "utf8")).toBe("key-a");
  });
});
