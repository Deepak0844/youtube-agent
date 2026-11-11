import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BACKUP_EVERY_MS, BACKUP_RETRY_AFTER_FAIL_MS } from "@/server/core/backup";
import { extraBackupDir, lastBackup, runBackup, saveBackupExtraDir, scheduledBackupTick, throttledBackup, type BackupDeps } from "@/server/db/backup";
import { withTestDb, type TestDb } from "../support/db";

// The backup runner on a real database, with the dump and the archive faked (so nothing here ever touches a real database dump or the dev container).
let db: TestDb;
let root: string;
const SESSION = "0190f3a2-7c1e-7a55-9d3b-2f6c8a1b4e91";
const extras: string[] = [];

beforeAll(async () => {
  db = await withTestDb();
});
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "bk-root-")));
  writeFileSync(path.join(root, "asset.bin"), "storage content");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const e of extras.splice(0)) rmSync(e, { recursive: true, force: true });
});

const T0 = new Date("2026-11-11T00:00:00.000Z");
const at = (ms: number) => () => new Date(T0.getTime() + ms);
/** Fakes: the dump writes a small file, tar writes the archive named in its arguments. */
const fakes = (over: Partial<BackupDeps> = {}): BackupDeps => ({
  root,
  now: at(0),
  dump: async (file) => writeFileSync(file, "dump-bytes"),
  exec: async (_cmd, args) => writeFileSync(args[args.indexOf("-czf") + 1]!, "archive-bytes"),
  ...over,
});
const folders = (dir: string) => readdirSync(dir).filter((n) => n.startsWith("backup-")).sort();
// Under the home folder, not the temp folder: on a Mac the temp folder lives under /private, which the extra-folder rule (rightly) refuses as a system folder.
const extraDir = () => {
  const d = realpathSync(mkdtempSync(path.join(homedir(), ".ytstudio-test-bk-extra-")));
  extras.push(d);
  return d;
};

describe("runBackup", () => {
  it("makes a backup folder with the dump and the archive, stores the result, and audits it (the schedule has no session)", async () => {
    const r = await runBackup(db.pool, null, fakes());
    expect(r).toMatchObject({ ok: true, at: T0.toISOString(), name: "backup-20261111T000000Z", bytes: "dump-bytes".length + "archive-bytes".length });
    expect(readdirSync(path.join(root, "backups", "backup-20261111T000000Z")).sort()).toEqual(["db.dump", "storage.tar.gz"]);
    expect(await lastBackup(db.pool)).toEqual(r);
    const a = (await db.pool.query("select detail from audit_log where event = 'backup.completed'")).rows[0].detail;
    expect(a).toMatchObject({ name: "backup-20261111T000000Z" });
    expect(a.sessionId ?? null).toBeNull();
    expect(JSON.stringify(a)).not.toContain(root);
  });
  it("keeps the newest 7 and removes older ones", async () => {
    for (let i = 0; i < 9; i++) await runBackup(db.pool, SESSION, fakes({ now: at(i * 3_600_000) }));
    expect(folders(path.join(root, "backups"))).toHaveLength(7);
    expect(folders(path.join(root, "backups"))[0]).toBe("backup-20261111T020000Z"); // the two oldest are gone
  });
  it("a failed dump stores a plain failure, removes the half-made folder, audits it and raises the in-app notice", async () => {
    const r = await runBackup(db.pool, SESSION, fakes({ dump: async () => { throw new Error("pg_dump: connection to postgres://user:SECRET@host failed"); } }));
    expect(r).toMatchObject({ ok: false });
    expect(JSON.stringify(r)).not.toMatch(/SECRET|postgres:\/\//);
    expect(existsSync(path.join(root, "backups", "backup-20261111T000000Z"))).toBe(false);
    expect((await db.pool.query("select count(*)::int n from audit_log where event = 'backup.failed'")).rows[0].n).toBe(1);
    expect((await db.pool.query("select count(*)::int n from notifications where event = 'backup_failed'")).rows[0].n).toBe(1);
  });
  it("only one backup runs at a time: a second one started meanwhile says so, stores nothing, and makes no folder", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    let started: () => void = () => undefined;
    const holding = new Promise<void>((r) => (started = r));
    const slow = runBackup(db.pool, SESSION, fakes({ dump: async (f) => { started(); await gate; writeFileSync(f, "d"); } }));
    await holding; // the first is inside its dump, so it holds the lock (no fixed wait: this cannot race on a slow machine)
    const second = await runBackup(db.pool, null, fakes({ now: at(60_000) }));
    expect(second).toMatchObject({ ok: false, error: expect.stringMatching(/already running/) });
    release();
    expect(await slow).toMatchObject({ ok: true });
    expect(folders(path.join(root, "backups"))).toEqual(["backup-20261111T000000Z"]);
    expect(await lastBackup(db.pool)).toMatchObject({ ok: true }); // the refusal did not overwrite the good result
    expect((await runBackup(db.pool, null, fakes({ now: at(120_000) }))).ok).toBe(true); // and the lock is free again afterwards
  });
});

describe("scheduledBackupTick (every 6 hours, an hour after a failure)", () => {
  it("makes the first backup at once, then nothing until 6 hours have passed", async () => {
    expect(await scheduledBackupTick(db.pool, fakes())).toMatchObject({ ok: true });
    expect(await scheduledBackupTick(db.pool, fakes({ now: at(BACKUP_EVERY_MS - 1) }))).toBeNull();
    expect(await scheduledBackupTick(db.pool, fakes({ now: at(BACKUP_EVERY_MS) }))).toMatchObject({ ok: true });
    expect(folders(path.join(root, "backups"))).toHaveLength(2);
  });
  it("after a failure it tries again in an hour, not six", async () => {
    const boom = fakes({ dump: async () => { throw new Error("down"); } });
    expect(await scheduledBackupTick(db.pool, boom)).toMatchObject({ ok: false });
    expect(await scheduledBackupTick(db.pool, fakes({ now: at(BACKUP_RETRY_AFTER_FAIL_MS - 1) }))).toBeNull();
    expect(await scheduledBackupTick(db.pool, fakes({ now: at(BACKUP_RETRY_AFTER_FAIL_MS) }))).toMatchObject({ ok: true });
  });
  it("the worker's throttled tick asks at most every few minutes and never throws, even when the dump fails", async () => {
    let clock = 0;
    const tick = throttledBackup(db.pool, { everyMs: 300_000, now: () => clock, deps: fakes({ dump: async () => { throw new Error("x"); } }) });
    await expect(tick()).resolves.toBeUndefined();
    const stored = await lastBackup(db.pool);
    expect(stored).toMatchObject({ ok: false });
    clock = 10_000; // inside the throttle window: it does not even ask
    await tick();
    expect((await db.pool.query("select count(*)::int n from audit_log where event = 'backup.failed'")).rows[0].n).toBe(1);
  });
});

describe("the extra copy", () => {
  it("copies every backup into the folder, keeps the newest 7 there too, and says so in the result", async () => {
    const extra = extraDir();
    expect(await saveBackupExtraDir(db.pool, SESSION, extra, { root })).toEqual({ ok: true, on: true });
    expect(await extraBackupDir(db.pool)).toBe(extra);
    for (let i = 0; i < 9; i++) {
      const r = await runBackup(db.pool, null, fakes({ now: at(i * 3_600_000) }));
      expect(r).toMatchObject({ ok: true, extra: "copied" });
    }
    expect(folders(extra)).toHaveLength(7);
    expect(readdirSync(path.join(extra, folders(extra)[0]!)).sort()).toEqual(["db.dump", "storage.tar.gz"]);
    expect(folders(extra)).toEqual(folders(path.join(root, "backups")));
  });
  it("a failing extra folder does not fail the backup: the local one is kept, the result says the extra copy failed, and a notice is raised", async () => {
    const extra = extraDir();
    await saveBackupExtraDir(db.pool, SESSION, extra, { root });
    rmSync(extra, { recursive: true, force: true }); // the drive was unplugged
    const r = await runBackup(db.pool, null, fakes());
    expect(r).toMatchObject({ ok: true, extra: "failed" });
    expect(folders(path.join(root, "backups"))).toHaveLength(1);
    expect((await db.pool.query("select count(*)::int n from notifications where event = 'backup_failed'")).rows[0].n).toBe(1);
  });
  it("refuses a folder that is a system folder, relative, not there, a file, or inside the app's own storage, and saves nothing", async () => {
    const file = path.join(root, "a-file");
    writeFileSync(file, "x");
    for (const bad of ["/etc", "/usr/local/x", "backups", "/", path.join(root, "gone"), file, root, path.join(root, "backups")]) {
      const r = await saveBackupExtraDir(db.pool, SESSION, bad, { root });
      expect(r.ok, bad).toBe(false);
    }
    expect(await extraBackupDir(db.pool)).toBe("");
    expect(await saveBackupExtraDir(db.pool, SESSION, 5, { root })).toMatchObject({ ok: false });
  });
  it("empty turns it off, and the audit says on or off but never the path", async () => {
    const extra = extraDir();
    await saveBackupExtraDir(db.pool, SESSION, extra, { root });
    expect(await saveBackupExtraDir(db.pool, SESSION, "  ", { root })).toEqual({ ok: true, on: false });
    expect(await extraBackupDir(db.pool)).toBe("");
    const rows = (await db.pool.query("select detail from audit_log where event = 'backup.extra_dir_changed' order by id")).rows.map((r) => r.detail);
    expect(rows).toEqual([{ sessionId: SESSION, on: true }, { sessionId: SESSION, on: false }]);
    expect(JSON.stringify(rows)).not.toContain(extra);
    const r = await runBackup(db.pool, null, fakes());
    expect(r).toMatchObject({ ok: true });
    expect((r as { extra?: string }).extra).toBeUndefined();
  });
  it("leaves no check file behind in the folder it tested", async () => {
    const extra = extraDir();
    await saveBackupExtraDir(db.pool, SESSION, extra, { root });
    expect(readdirSync(extra)).toEqual([]);
    mkdirSync(path.join(extra, "other"));
    await runBackup(db.pool, null, fakes());
    expect(readdirSync(extra).filter((n) => n.startsWith(".write-check"))).toEqual([]);
    expect(existsSync(path.join(extra, "other"))).toBe(true); // never touches names that are not backups
  });
});
