import { describe, expect, it } from "vitest";
import { backupName, backupResultSchema, backupsToDelete, describeBackup, formatBytes, isBackupName } from "@/server/core/backup";
import { formatIst } from "@/server/core/display-format";

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
    expect(ok).toEqual({ tone: "ok", text: "Last backup 07 Nov 2026, 14:00 IST, 2.0 KB." });
    expect(describeBackup({ ok: false, at: "2026-11-07T08:30:00.000Z", error: "Disk full." })).toEqual({ tone: "failed", text: "Backup failed at 07 Nov 2026, 14:00 IST. Disk full." });
  });

  it("result_schema_refuses_extra_fields", () => {
    expect(backupResultSchema.safeParse({ ok: false, at: "2026-11-07T08:30:00.000Z", error: "x", secret: "y" }).success).toBe(false);
    expect(formatIst("nope")).toBe("");
  });
});
