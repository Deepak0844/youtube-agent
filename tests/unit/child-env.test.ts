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
  it("parses_lstart_in_local_time", () => {
    expect(parseLstart("Mon Oct 27 10:00:00 2026")).toBe(Math.floor(new Date(2026, 9, 27, 10, 0, 0).getTime() / 1000));
    expect(parseLstart("Tue Jan  5 03:04:05 2027")).toBe(Math.floor(new Date(2027, 0, 5, 3, 4, 5).getTime() / 1000));
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
