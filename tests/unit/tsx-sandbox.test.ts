import { describe, expect, it } from "vitest";
import { renderArgs } from "@/server/providers/renderer/remotion-container";
import { TSX_EXTRA_FLAGS, TSX_SANDBOX, tsxRenderPlan } from "@/server/providers/renderer/tsx-sandbox";

const base = {
  name: "ytstudio-render-run-1-abcd1234",
  host: { cpus: 8, memoryMb: 16000 },
  imageRef: "sha256:" + "a".repeat(64),
  workerId: "w-1",
  inDir: "/data/a/render-in",
  outDir: "/data/a/render-out",
  kitDir: "/repo/remotion/kit",
};
const kitConfig = { timeoutS: 1800, cpus: 4, memoryMb: 4096, pids: 512 };
const flag = (a: string[], f: string) => a[a.indexOf(f) + 1];

describe("tsxRenderPlan", () => {
  it("is the kit's hardened run plus tighter limits, in exact order", () => {
    const p = tsxRenderPlan({ ...base, config: kitConfig });
    expect(p.args).toEqual([
      "run", "--rm", "--name", base.name,
      "--pull=never", "--network", "none", "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=1g,mode=1777", "--shm-size=256m",
      "--user", "10001:10001", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--pids-limit", "256", "--memory", "2048m", "--memory-swap", "2048m", "--cpus", "2",
      "--ulimit", `fsize=${512 * 1024 * 1024}:${512 * 1024 * 1024}`, "--ulimit", "core=0:0",
      "--log-driver", "none", "--label", `ytstudio.job=${base.name}`, "--label", "ytstudio.worker=w-1",
      "-v", "/data/a/render-in:/in:ro", "-v", "/data/a/render-out:/out:rw", "-v", "/repo/remotion/kit:/opt/render/kit:ro",
      "-w", "/tmp", "--entrypoint", "node", base.imageRef, "/opt/render/kit/render-entry.mjs", "/in", "/out/out.mp4",
    ]);
    expect(p.timeoutMs).toBe(300_000);
    expect(p.maxVideoBytes).toBe(512 * 1024 * 1024);
    expect(p.maxOutputBytes).toBe(256 * 1024);
  });

  it("keeps every kit flag and only adds", () => {
    const kit = renderArgs({ ...base, limits: kitConfig });
    const tsx = tsxRenderPlan({ ...base, config: kitConfig }).args;
    expect(flag(tsx, "--network")).toBe("none");
    expect(flag(tsx, "--user")).toBe("10001:10001");
    expect(flag(tsx, "--cap-drop")).toBe("ALL");
    expect(flag(tsx, "--security-opt")).toBe("no-new-privileges");
    expect(flag(tsx, "--tmpfs")).toBe(flag(kit, "--tmpfs"));
    expect(tsx).toContain("--read-only");
    expect(tsx).toContain("--pull=never");
    // same tail (labels, the three mounts, workdir, entrypoint, image, entry script) and same lock head
    const tail = kit.indexOf("--log-driver");
    expect(tsx.slice(tsx.indexOf("--log-driver"))).toEqual(kit.slice(tail));
    expect(tsx.slice(0, kit.indexOf("--pids-limit"))).toEqual(kit.slice(0, kit.indexOf("--pids-limit")));
    expect(tsx.filter((a) => a === "-v")).toHaveLength(3);
    for (const f of ["--privileged", "--cap-add", "--network=host", "host", "--pid", "--ipc", "--device", "-e", "--env", "--env-file", "--volumes-from", "-p", "--publish"]) {
      expect(tsx).not.toContain(f);
    }
    expect(tsx.some((a) => a.includes("docker.sock"))).toBe(false);
    expect(TSX_EXTRA_FLAGS.every((f) => tsx.includes(f))).toBe(true);
  });

  it("limits only go down: config, TSX caps and the daemon all clamp", () => {
    const small = tsxRenderPlan({ ...base, host: { cpus: 1, memoryMb: 1000 }, config: { timeoutS: 120, cpus: 1, memoryMb: 512, pids: 64 } });
    expect(flag(small.args, "--cpus")).toBe("1");
    expect(flag(small.args, "--memory")).toBe("512m");
    expect(flag(small.args, "--pids-limit")).toBe("64");
    expect(small.timeoutMs).toBe(60_000);
    const huge = tsxRenderPlan({ ...base, host: { cpus: 64, memoryMb: 256000 }, config: { timeoutS: 99999, cpus: 64, memoryMb: 999999, pids: 99999 } });
    expect(flag(huge.args, "--cpus")).toBe(String(TSX_SANDBOX.cpus));
    expect(flag(huge.args, "--memory")).toBe(`${TSX_SANDBOX.memoryMb}m`);
    expect(flag(huge.args, "--memory-swap")).toBe(`${TSX_SANDBOX.memoryMb}m`);
    expect(flag(huge.args, "--pids-limit")).toBe(String(TSX_SANDBOX.pids));
    expect(huge.timeoutMs).toBe(TSX_SANDBOX.timeoutS * 1000);
    const lowHost = tsxRenderPlan({ ...base, host: { cpus: 1.5, memoryMb: 1000 }, config: kitConfig });
    expect(flag(lowHost.args, "--cpus")).toBe("1.5");
    expect(flag(lowHost.args, "--memory")).toBe("900m");
  });

  it("the TSX wall clock is always shorter than the kit's", () => {
    for (const timeoutS of [2, 60, 600, 1800, 7200]) {
      expect(tsxRenderPlan({ ...base, config: { ...kitConfig, timeoutS } }).timeoutMs).toBeLessThan(timeoutS * 1000);
    }
  });

  it("refuses unusable settings instead of loosening", () => {
    for (const bad of [0, -1, NaN, Infinity]) {
      for (const k of ["timeoutS", "cpus", "memoryMb", "pids"] as const) {
        expect(() => tsxRenderPlan({ ...base, config: { ...kitConfig, [k]: bad } })).toThrow();
      }
    }
  });

  it("an unusable worker id is not passed through", () => {
    expect(tsxRenderPlan({ ...base, workerId: "bad id;rm", config: kitConfig }).args).toContain("ytstudio.worker=unknown");
  });
});
