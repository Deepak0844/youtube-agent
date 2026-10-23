import { describe, expect, it, vi } from "vitest";
import { startWorker } from "@/worker";

describe("worker entrypoint", () => {
  it("logs start and stop", async () => {
    const log = vi.fn();
    const worker = startWorker(log);
    expect(log).toHaveBeenLastCalledWith("worker started");
    await worker.stop();
    expect(log).toHaveBeenLastCalledWith("worker stopped");
  });
});
