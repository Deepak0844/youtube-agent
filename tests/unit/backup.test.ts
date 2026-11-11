import { describe, expect, it } from "vitest";
import { BACKUP_EVERY_MS, BACKUP_RETRY_AFTER_FAIL_MS, backupDue, backupName, backupResultSchema, backupsToDelete, describeBackup, dumpPlan, extraDirProblem, formatBytes, isBackupName, parseMigrationNames, pickBackup, schemaProblem } from "@/server/core/backup";

describe("backup rules", () => {
  it("names_a_backup_folder_from_the_utc_time", () => {
    expect(backupName(new Date("2026-11-07T08:30:05.123Z"))).toBe("backup-20261107T083005Z");
    expect(isBackupName("backup-20261107T083005Z")).toBe(true);
    expect(isBackupName("../etc")).toBe(false);
  });

  it("keeps_the_newest_seven_and_never_touches_other_names", () => {
    const names = Array.from({ length: 9 }, (_, i) => `backup-2026110${i + 1}T000000Z`);
    expect(backupsToDelete([...names, "notes.txt", "keep-me"]).sort()).toEqual([names[0], names[1]]);
    expect(backupsToDelete(names.slice(0, 7))).toEqual([]);
  });

  it("formats_sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 ** 3)).toBe("5.0 GB");
  });

  it("describes_none_ok_and_failed_in_ist", () => {
    expect(describeBackup(null).tone).toBe("none");
    const ok = describeBackup({ ok: true, at: "2026-11-07T08:30:00.000Z", bytes: 2048, name: "x" });
    expect(ok).toEqual({ tone: "ok", text: "Last backup 2026-11-07 14:00 IST, 2.0 KB." });
    expect(describeBackup({ ok: false, at: "2026-11-07T08:30:00.000Z", error: "Disk full." })).toEqual({ tone: "failed", text: "Backup failed at 2026-11-07 14:00 IST. Disk full." });
  });

  it("result_schema_refuses_extra_fields", () => {
    expect(backupResultSchema.safeParse({ ok: false, at: "2026-11-07T08:30:00.000Z", error: "x", secret: "y" }).success).toBe(false);
  });
});

describe("dumpPlan", () => {
  const o = { container: "ytstudio-dev-pg", user: "ytstudio", db: "ytstudio" };
  it("prefers_pg_dump_on_path", () => {
    expect(dumpPlan({ pgDump: true, containerRunning: true }, o)).toEqual({ kind: "local" });
  });
  it("falls_back_to_docker_exec_with_no_password_argument", () => {
    expect(dumpPlan({ pgDump: false, containerRunning: true }, o)).toEqual({
      kind: "docker",
      args: ["exec", "-i", "ytstudio-dev-pg", "pg_dump", "--format=custom", "-U", "ytstudio", "ytstudio"],
    });
  });
  it("says_what_to_do_when_neither_exists", () => {
    expect(dumpPlan({ pgDump: false, containerRunning: false }, o)).toEqual({ kind: "none", message: "Install Postgres client tools or start the database container." });
  });
});

describe("backupDue (every 6 hours, sooner after a failure)", () => {
  const at = "2026-11-11T00:00:00.000Z";
  const t = (ms: number) => new Date(new Date(at).getTime() + ms);
  it("is due when no backup was ever made", () => expect(backupDue(null, new Date())).toBe(true));
  it("a good backup is not due until 6 hours have passed", () => {
    const ok = { ok: true as const, at, bytes: 1, name: "backup-20261111T000000Z" };
    expect(backupDue(ok, t(BACKUP_EVERY_MS - 1))).toBe(false);
    expect(backupDue(ok, t(BACKUP_EVERY_MS))).toBe(true);
  });
  it("a failed backup is tried again after an hour, not six", () => {
    const bad = { ok: false as const, at, error: "x" };
    expect(backupDue(bad, t(BACKUP_RETRY_AFTER_FAIL_MS - 1))).toBe(false);
    expect(backupDue(bad, t(BACKUP_RETRY_AFTER_FAIL_MS))).toBe(true);
  });
  it("a clock that went backwards does not cause a backup loop", () => {
    expect(backupDue({ ok: true, at, bytes: 1, name: "n" }, t(-3_600_000))).toBe(false);
    expect(backupDue({ ok: true, at: "garbage", bytes: 1, name: "n" } as never, new Date())).toBe(false);
  });
});

describe("the extra copy shows in the last-backup text", () => {
  const base = { ok: true as const, at: "2026-11-07T08:30:00.000Z", bytes: 2048, name: "backup-20261107T083000Z" };
  it("says nothing extra when none is set up, says copied, and calls a failed copy a failure", () => {
    expect(describeBackup(base).text).toBe("Last backup 2026-11-07 14:00 IST, 2.0 KB.");
    expect(describeBackup({ ...base, extra: "copied" })).toEqual({ tone: "ok", text: "Last backup 2026-11-07 14:00 IST, 2.0 KB. Also copied to your extra folder." });
    expect(describeBackup({ ...base, extra: "failed" }).tone).toBe("failed");
    expect(describeBackup({ ...base, extra: "failed" }).text).toMatch(/extra copy to your folder FAILED/);
  });
  it("the stored result accepts only the two known extra values", () => {
    expect(backupResultSchema.safeParse({ ...base, extra: "copied" }).success).toBe(true);
    expect(backupResultSchema.safeParse({ ...base, extra: "maybe" }).success).toBe(false);
  });
});

describe("pickBackup", () => {
  const names = ["backup-20261105T000000Z", "backup-20261107T060000Z", "backup-20261106T120000Z", "notes.txt", "keep-me"];
  it("--latest is the newest backup by its name, and other names are ignored", () => expect(pickBackup(names, "--latest")).toEqual({ ok: true, name: "backup-20261107T060000Z" }));
  it("a name or a pasted full path picks that backup", () => {
    expect(pickBackup(names, "backup-20261105T000000Z")).toEqual({ ok: true, name: "backup-20261105T000000Z" });
    expect(pickBackup(names, "/Users/me/storage/backups/backup-20261106T120000Z/")).toEqual({ ok: true, name: "backup-20261106T120000Z" });
  });
  it("refuses anything that is not a listed backup name, and never turns a path into another place", () => {
    for (const bad of ["", "latest", "../backup-20261105T000000Z/../../etc", "backup-20261101T000000Z", "notes.txt", "backup-1"]) {
      const r = pickBackup(names, bad);
      expect(r.ok, bad).toBe(false);
    }
    expect(pickBackup(["notes.txt"], "--latest")).toEqual({ ok: false, reason: "There are no backups to restore from." });
  });
});

describe("migration check (refuse a backup from a newer app)", () => {
  const dump = "--\n-- Data for Name: schema_migrations\n--\n\nCOPY public.schema_migrations (name, applied_at) FROM stdin;\n0001_init.sql\t2026-10-01 10:00:00+00\n0002_more.sql\t2026-10-02 10:00:00+00\n\\.\n\n";
  it("reads the migration names from the COPY block of a data dump", () => expect(parseMigrationNames(dump)).toEqual(["0001_init.sql", "0002_more.sql"]));
  it("finds nothing in text without the block, and ignores odd lines", () => {
    expect(parseMigrationNames("nothing here")).toEqual([]);
    expect(parseMigrationNames("COPY public.schema_migrations (name, applied_at) FROM stdin;\n../../etc/passwd\t1\nnot a migration\t2\n\\.\n")).toEqual([]);
  });
  it("is fine when every migration in the backup is known, and refuses one from a newer app, naming the first", () => {
    expect(schemaProblem(["0001_init.sql", "0002_more.sql"], ["0001_init.sql", "0002_more.sql", "0003_new.sql"])).toBeNull();
    const p = schemaProblem(["0001_init.sql", "0003_new.sql", "0004_newer.sql"], ["0001_init.sql", "0002_more.sql"]);
    expect(p).toMatch(/NEWER version/);
    expect(p).toMatch(/2 database changes/);
    expect(p).toMatch(/0003_new\.sql/);
    expect(p).toMatch(/Nothing was changed/);
  });
  it("a backup that does not say its version cannot be checked and is refused", () => expect(schemaProblem([], ["0001_init.sql"])).toMatch(/cannot be checked/));
});

describe("extraDirProblem (the optional second copy)", () => {
  const root = "/Users/me/app/storage";
  it("empty means off, and a normal folder or an external drive is fine", () => {
    expect(extraDirProblem("", root)).toBeNull();
    expect(extraDirProblem("  ", root)).toBeNull();
    expect(extraDirProblem("/Volumes/Backup/ytstudio", root)).toBeNull();
    expect(extraDirProblem("/Users/me/Dropbox/backups", root)).toBeNull();
  });
  it("refuses a relative path, the whole disk, dot parts, control characters and a very long name", () => {
    for (const bad of ["backups", "./x", "~/x", "/", "//", "/Volumes/../etc", "/Volumes/./x", "/Volumes/x\u0000y", `/${"a".repeat(500)}`]) expect(extraDirProblem(bad, root), bad).not.toBeNull();
  });
  it("refuses system folders and anything under them", () => {
    for (const bad of ["/System", "/usr/local/x", "/etc", "/var/db", "/private/tmp", "/Library/Caches", "/Applications", "/dev/x"]) expect(extraDirProblem(bad, root), bad).toMatch(/system folder/);
  });
  it("refuses the app's own storage, a folder inside it, and a folder that contains it", () => {
    for (const bad of [root, `${root}/backups`, "/Users/me/app", "/Users/me"]) expect(extraDirProblem(bad, root), bad).toMatch(/own storage/);
  });
});
