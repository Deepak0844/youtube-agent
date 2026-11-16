import { describe, expect, it } from "vitest";
import { mergeWorkerToolChecks, type ToolCheck } from "@/server/core/tool-check";

const row = (id: ToolCheck["id"], ok: boolean, detail = ok ? "fine" : "nope"): ToolCheck => ({ id, label: id, ok, detail, fix: ok ? null : "fix it" });
const now = new Date("2026-11-17T10:00:00Z");
const ago = (min: number) => new Date(now.getTime() - min * 60_000);
const local = [row("ffmpeg", true, "v7"), row("ffprobe", true, "v7"), row("docker", false), row("render_image", false)];

describe("mergeWorkerToolChecks", () => {
  it("uses the worker's docker rows and says how old they are", () => {
    const worker = { checks: [row("docker", true, "version 27"), row("render_image", true, "Built and ready.")], at: ago(2) };
    const m = mergeWorkerToolChecks(local, worker, now);
    expect(m.find((c) => c.id === "docker")).toMatchObject({ ok: true, detail: "version 27 (checked by the worker 2 min ago)" });
    expect(m.find((c) => c.id === "render_image")?.ok).toBe(true);
  });
  it("a missing or stale worker report is a visible failure, never ok", () => {
    for (const w of [null, { checks: [row("docker", true)], at: ago(16) }]) {
      const m = mergeWorkerToolChecks(local, w, now);
      for (const id of ["docker", "render_image"] as const) {
        expect(m.find((c) => c.id === id)).toMatchObject({ ok: false, detail: "The worker has not reported yet.", fix: "Start the worker container and wait a minute." });
      }
    }
  });
  it("ffmpeg and ffprobe rows are untouched", () => {
    const m = mergeWorkerToolChecks(local, null, now);
    expect(m.filter((c) => c.id === "ffmpeg" || c.id === "ffprobe")).toEqual(local.slice(0, 2));
  });
});
