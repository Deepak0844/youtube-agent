import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildChildEnv, ChildError, runChild } from "@/server/render/child";
import { commandLabelOf, parseLstart } from "@/server/render/proc-info";

const SECRETS = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: "/home/owner",
  VAULT_MASTER_KEY: "mk-secret",
  DATABASE_URL: "postgres://u:p@h/db",
  REDIS_URL: "redis://h",
  ANTHROPIC_API_KEY: "sk-ant-xxxxxxxxxxxxxxxx",
  SESSION_SECRET: "s3",
};

describe("child env allow-list", () => {
  it("defaults_to_PATH_only_and_leaves_HOME_unset", () => {
    expect(buildChildEnv(undefined, SECRETS)).toEqual({ PATH: SECRETS.PATH });
  });

  it("copies_only_names_that_are_allowed_and_set", () => {
    expect(buildChildEnv(["PATH", "LANG"], { ...SECRETS })).toEqual({ PATH: SECRETS.PATH });
    expect(buildChildEnv(["PATH", "LANG"], { ...SECRETS, LANG: "C" })).toEqual({ PATH: SECRETS.PATH, LANG: "C" });
  });

  it("refuses_secret_looking_names_even_if_a_caller_allows_them", () => {
    for (const n of ["VAULT_MASTER_KEY", "DATABASE_URL", "REDIS_URL", "ANTHROPIC_API_KEY", "SESSION_SECRET", "GITHUB_TOKEN"]) {
      expect(() => buildChildEnv([n], SECRETS), n).toThrow(ChildError);
    }
  });

  it("refuses_names_that_change_what_code_the_child_loads", () => {
    for (const n of ["LD_PRELOAD", "LD_LIBRARY_PATH", "NODE_OPTIONS", "DYLD_INSERT_LIBRARIES", "DYLD_FALLBACK_LIBRARY_PATH", "BASH_ENV", "pythonpath"]) {
      expect(() => buildChildEnv([n], { ...SECRETS, [n]: "x" }), n).toThrow(ChildError);
    }
  });

  it("cwdRoot_refuses_a_cwd_outside_the_root_including_via_symlink_and_prefix_tricks", async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), "cwdroot-"));
    try {
      const root = path.join(base, "root");
      mkdirSync(path.join(root, "job"), { recursive: true });
      mkdirSync(path.join(base, "root-evil"));
      symlinkSync(base, path.join(root, "escape"));
      const run = (cwd: string) =>
        runChild({ command: process.execPath, args: ["-e", "0"], cwd, cwdRoot: root, timeoutMs: 10_000, maxOutputBytes: 1024, signal: new AbortController().signal, stageRunId: "x" });
      expect((await run(path.join(root, "job"))).code).toBe(0);
      expect((await run(root)).code).toBe(0);
      await expect(run(path.join(base, "root-evil"))).rejects.toThrow(ChildError);
      await expect(run(path.join(root, "escape"))).rejects.toThrow(ChildError);
      await expect(run(path.join(root, "nope"))).rejects.toThrow(ChildError);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("refuses_malformed_names", () => {
    expect(() => buildChildEnv(["A=B"], SECRETS)).toThrow(ChildError);
    expect(() => buildChildEnv([""], SECRETS)).toThrow(ChildError);
  });

  it("child_env_has_no_secrets", async () => {
    const lines: string[] = [];
    const r = await runChild(
      {
        command: process.execPath,
        args: ["-e", "console.log(JSON.stringify(process.env))"],
        cwd: process.cwd(),
        timeoutMs: 10_000,
        maxOutputBytes: 1 << 20,
        signal: new AbortController().signal,
        onLine: (l) => lines.push(l),
        stageRunId: "00000000-0000-0000-0000-000000000000",
      },
      { env: SECRETS },
    );
    expect(r.code).toBe(0);
    const seen = JSON.parse(lines.join("")) as Record<string, string>;
    for (const k of Object.keys(SECRETS).filter((k) => k !== "PATH")) expect(seen[k], k).toBeUndefined();
    expect(JSON.stringify(seen)).not.toContain("mk-secret");
    expect(seen.PATH).toBe(SECRETS.PATH);
  });
});

describe("ps parsing", () => {
  it("parses_lstart_as_utc_whatever_the_process_timezone", () => {
    const want = Date.UTC(2026, 9, 27, 10, 0, 0) / 1000;
    const tz = process.env.TZ;
    try {
      for (const z of ["UTC", "Asia/Kolkata", "America/New_York"]) {
        process.env.TZ = z;
        expect(parseLstart("Mon Oct 27 10:00:00 2026"), z).toBe(want);
      }
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
    expect(parseLstart("Tue Jan  5 03:04:05 2027")).toBe(Date.UTC(2027, 0, 5, 3, 4, 5) / 1000);
  });
  it("rejects_garbage", () => {
    expect(parseLstart("")).toBeNull();
    expect(parseLstart("not a date")).toBeNull();
  });
  it("label_is_the_basename_of_the_first_word", () => {
    expect(commandLabelOf("/usr/bin/ffprobe -v error x.mp4")).toBe("ffprobe");
    expect(commandLabelOf("sleep 300")).toBe("sleep");
  });
});
