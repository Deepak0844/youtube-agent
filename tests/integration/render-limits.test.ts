import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildDockerArgs } from "@/server/render/runner";

// A small host (like a 2-CPU CI runner) is simulated by injecting what the daemon reports.
const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ytstudio-limits-")));
const jobDir = path.join(root, "videos", "j1");
mkdirSync(jobDir, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

const flag = (args: string[], name: string) => args[args.indexOf(name) + 1] ?? "";
const build = (host: { cpus: number; memoryMb: number }, limits?: { cpus: number; memoryMb: number; pids: number }) =>
  buildDockerArgs({ jobId: "j1", storageRoot: root, jobDir, command: ["true"], limits }, host);

describe("limits are clamped to the daemon's resources", () => {
  it("cpus_default_is_clamped_to_daemon_cpus", async () => {
    expect(flag(await build({ cpus: 2, memoryMb: 16384 }), "--cpus")).toBe("2");
  });
  it("caller_cpus_above_daemon_are_clamped", async () => {
    expect(flag(await build({ cpus: 2, memoryMb: 16384 }, { cpus: 8, memoryMb: 1024, pids: 64 }), "--cpus")).toBe("2");
  });
  it("cpus_below_daemon_are_unchanged", async () => {
    expect(flag(await build({ cpus: 16, memoryMb: 65536 }), "--cpus")).toBe("4");
    expect(flag(await build({ cpus: 16, memoryMb: 65536 }, { cpus: 1.5, memoryMb: 512, pids: 64 }), "--cpus")).toBe("1.5");
  });
  it("memory_default_is_clamped_to_daemon_memory", async () => {
    const args = await build({ cpus: 4, memoryMb: 2000 });
    const mem = Number.parseInt(flag(args, "--memory"), 10);
    expect(mem).toBeLessThan(2000);
    expect(mem).toBeGreaterThan(1000);
    expect(flag(args, "--memory-swap")).toBe(flag(args, "--memory"));
  });
  it("memory_is_never_raised_above_the_request", async () => {
    expect(flag(await build({ cpus: 4, memoryMb: 65536 }), "--memory")).toBe("4096m");
  });
});
