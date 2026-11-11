import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backupTime, describeListItem, listBackups, unsafeArchiveNames } from "@/server/db/backup-restore";

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "bkr-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const make = (name: string, files: Record<string, string>) => {
  const d = path.join(root, "backups", name);
  mkdirSync(d, { recursive: true });
  for (const [f, c] of Object.entries(files)) writeFileSync(path.join(d, f), c);
};

describe("backupTime", () => {
  it("reads the UTC time out of a backup folder name, and gives nothing for any other name", () => {
    expect(backupTime("backup-20261107T083005Z")).toBe("2026-11-07T08:30:05.000Z");
    for (const bad of ["", "backup-1", "../backup-20261107T083005Z", "notes"]) expect(backupTime(bad), bad).toBe("");
  });
});

describe("unsafeArchiveNames", () => {
  it("flags absolute paths and .. parts, and lets plain relative paths through", () => {
    const listing = ["videos/a/final.mp4", "./assets/b.png", "/etc/passwd", "../outside", "videos/../../x", "ok/..name/file", ""].join("\n");
    expect(unsafeArchiveNames(listing)).toEqual(["/etc/passwd", "../outside", "videos/../../x"]);
  });
  it("an empty listing has nothing unsafe", () => expect(unsafeArchiveNames("")).toEqual([]));
});

describe("listBackups", () => {
  it("lists newest first, with sizes, and says whether the files archive is there", async () => {
    make("backup-20261105T000000Z", { "db.dump": "1234", "storage.tar.gz": "12" });
    make("backup-20261107T060000Z", { "db.dump": "12345678" });
    const l = await listBackups(root);
    expect(l.map((b) => [b.name, b.bytes, b.hasStorage, b.at])).toEqual([
      ["backup-20261107T060000Z", 8, false, "2026-11-07T06:00:00.000Z"],
      ["backup-20261105T000000Z", 6, true, "2026-11-05T00:00:00.000Z"],
    ]);
    expect(describeListItem(l[0]!)).toBe("backup-20261107T060000Z  8 B  database only");
    expect(describeListItem(l[1]!)).toBe("backup-20261105T000000Z  6 B  database + files");
  });
  it("leaves out folders without a dump, names that are not backups, plain files, and a dump that is a link", async () => {
    make("backup-20261105T000000Z", { "storage.tar.gz": "x" }); // no dump
    make("not-a-backup", { "db.dump": "x" });
    writeFileSync(path.join(root, "backups", "backup-20261106T000000Z"), "a file, not a folder");
    make("backup-20261107T000000Z", {});
    writeFileSync(path.join(root, "target"), "secret");
    symlinkSync(path.join(root, "target"), path.join(root, "backups", "backup-20261107T000000Z", "db.dump"));
    expect(await listBackups(root)).toEqual([]);
  });
  it("is empty when there is no backups folder at all", async () => expect(await listBackups(root)).toEqual([]));
});
