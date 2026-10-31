import { describe, expect, it } from "vitest";
import { workerHooksFor } from "@/worker/handlers";

describe("worker hooks", () => {
  it("the render container boot sweep is wired only for the real worker, never the dry run", () => {
    const pool = {} as never;
    expect(workerHooksFor(pool, { ENGINE_DRY_RUN: "1" })).toEqual({});
    expect(workerHooksFor(pool, {}).sweepRenderContainers).toBeTypeOf("function");
    expect(workerHooksFor(pool, { ENGINE_DRY_RUN: "0" }).sweepRenderContainers).toBeTypeOf("function");
  });
});
