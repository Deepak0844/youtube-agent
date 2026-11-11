import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runBackup, type PgMode } from "@/server/db/backup";
import { createPool } from "@/server/db/pool";
import { listBackups, restoreBackup, type RestoreDeps } from "@/server/db/backup-restore";
import { APP_PW, withTestDb, type TestDb } from "../support/db";

// The restore command on a REAL database and a real pg_dump / pg_restore (run inside the test database's own container, so the tool version always matches
// the server). One story, in order: make backups while the app is "running", prove a restore refuses while it is, then stop the app (close its connections)
// and prove every refusal and finally a real restore. The state is changed between the backup and the restore so the restore has something to undo.
const run = promisify(execFile);
const SESSION = "0190f3a2-7c1e-7a55-9d3b-2f6c8a1b4e91";
const T0 = new Date("2026-11-11T00:00:00.000Z");
const at = (h: number) => () => new Date(T0.getTime() + h * 3_600_000);
const NAME = (h: number) => `backup-${new Date(T0.getTime() + h * 3_600_000).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`;

let db: TestDb;
let app: ReturnType<typeof createPool>; // this test's own app-role pool (a running app); db.pool is never used, so db.stop() can end it as usual
let appUrl: string;
let root: string;
let mode: PgMode;
let deps: RestoreDeps;

beforeAll(async () => {
  db = await withTestDb();
  const au = new URL(db.ownerUrl);
  au.username = "ytstudio_app";
  au.password = APP_PW;
  appUrl = au.toString();
  app = createPool(appUrl);
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "bk-restore-")));
  // The test database's container: found by its published port; its own superuser logs in locally (no password), exactly like the dev container path.
  const url = new URL(db.ownerUrl);
  const id = (await run("docker", ["ps", "-q", "--filter", `publish=${url.port}`])).stdout.trim().split("\n")[0] ?? "";
  expect(id, "the test database container").not.toBe("");
  const user = (await run("docker", ["exec", id, "printenv", "POSTGRES_USER"])).stdout.trim();
  mode = { kind: "docker", container: id, user, db: decodeURIComponent(url.pathname.slice(1)) };
  deps = { root, pgMode: mode };
}, 120_000);
afterAll(async () => {
  if (root) rmSync(root, { recursive: true, force: true });
  await app?.end().catch(() => undefined);
  await db?.stop();
});

const videoCount = async () => Number((await db.ownerPool.query("select count(*)::int n from videos")).rows[0].n);
const storageFile = (...p: string[]) => path.join(root, ...p);
const tarList = async (archive: string) => (await run("tar", ["-tzf", archive])).stdout;

describe("backup, then restore (real pg_dump and pg_restore)", () => {
  let a: string; // the good backup
  let b: string; // a backup whose database is from a NEWER app
  const c = NAME(2); // a dump that is garbage
  const d = NAME(3); // a files archive with an absolute path in it
  let videoId: string;

  it("makes real backups of a database with a video and a file in it", async () => {
    videoId = (await db.ownerPool.query("insert into videos (format, kind, language, topic) values ('short','scene_kit','en','Why the sea is salty') returning id")).rows[0].id;
    mkdirSync(storageFile("videos", videoId), { recursive: true });
    writeFileSync(storageFile("videos", videoId, "scenes.json"), '{"scenes":"before"}');

    const ra = await runBackup(app, SESSION, { ...deps, now: at(0) });
    expect(ra).toMatchObject({ ok: true });
    a = NAME(0);
    expect(readdirSync(storageFile("backups", a)).sort()).toEqual(["db.dump", "storage.tar.gz"]);

    // a backup from a "newer app": its schema_migrations holds a migration this app does not have
    await db.ownerPool.query("insert into schema_migrations (name) values ('9999_from_the_future.sql')");
    expect(await runBackup(app, SESSION, { ...deps, now: at(1) })).toMatchObject({ ok: true });
    b = NAME(1);
    await db.ownerPool.query("delete from schema_migrations where name = '9999_from_the_future.sql'");

    // a garbage dump and an unsafe archive, named like backups
    mkdirSync(storageFile("backups", c), { recursive: true });
    writeFileSync(storageFile("backups", c, "db.dump"), "this is not a database dump");
    mkdirSync(storageFile("backups", d), { recursive: true });
    writeFileSync(storageFile("backups", d, "db.dump"), readFileSync(storageFile("backups", a, "db.dump")));
    writeFileSync(storageFile("evil-source.txt"), "x");
    await run("tar", ["-czPf", storageFile("backups", d, "storage.tar.gz"), storageFile("evil-source.txt")]); // -P keeps the absolute path
    rmSync(storageFile("evil-source.txt"));

    expect((await listBackups(root)).map((x) => x.name)).toEqual([d, c, b, a]);
  }, 180_000);

  it("changes the state after the backup, so a restore has something to undo", async () => {
    await db.ownerPool.query("delete from videos where id = $1", [videoId]);
    writeFileSync(storageFile("videos", videoId, "scenes.json"), '{"scenes":"after"}');
    writeFileSync(storageFile("after-backup.txt"), "made after the backup");
    expect(await videoCount()).toBe(0);
  });

  it("refuses while the app or the worker is connected to the database, and changes nothing", async () => {
    await app.query("select 1"); // the app role has an open connection, as a running app would
    const r = await restoreBackup(db.ownerPool, { name: a, yes: true }, deps);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/still connected to the database/);
    expect(!r.ok && r.reason).toMatch(/Nothing was changed/);
    expect(await videoCount()).toBe(0);
    expect(readFileSync(storageFile("videos", videoId, "scenes.json"), "utf8")).toBe('{"scenes":"after"}');
    expect(readdirSync(storageFile("backups")).filter((n) => n.startsWith("backup-")).sort()).toEqual([a, b, c, d]); // no safety backup was made either
  });

  it("with the app stopped, a dry run checks everything and changes nothing", async () => {
    // the app is stopped: every connection of the app role is closed from the server side
    await db.superPool.query("select pg_terminate_backend(pid) from pg_stat_activity where usename = 'ytstudio_app' and pid <> pg_backend_pid()");
    await new Promise((r) => setTimeout(r, 500));
    const r = await restoreBackup(db.ownerPool, { name: a, yes: false }, deps);
    expect(r.ok).toBe(true);
    expect(r.ok && r.dryRun).toBe(true);
    expect(r.steps.join("\n")).toMatch(/dump can be read/);
    expect(r.steps.join("\n")).toMatch(/Dry run: nothing was changed/);
    expect(await videoCount()).toBe(0);
    expect(existsSync(storageFile("after-backup.txt"))).toBe(true);
  });

  it("refuses a garbage dump, a backup from a newer app, an archive with an absolute path, and a name that is not a backup, each changing nothing", async () => {
    const garbage = await restoreBackup(db.ownerPool, { name: c, yes: true }, deps);
    expect(!garbage.ok && garbage.reason).toMatch(/cannot be read|not a database backup/);
    const newer = await restoreBackup(db.ownerPool, { name: b, yes: true }, deps);
    expect(!newer.ok && newer.reason).toMatch(/NEWER version of the app/);
    expect(!newer.ok && newer.reason).toMatch(/9999_from_the_future\.sql/);
    const evil = await restoreBackup(db.ownerPool, { name: d, yes: true }, deps);
    expect(!evil.ok && evil.reason).toMatch(/outside the storage folder/);
    for (const bad of ["../backups", "latest-ish", "backup-20990101T000000Z"]) expect((await restoreBackup(db.ownerPool, { name: bad, yes: true }, deps)).ok, bad).toBe(false);
    expect(await videoCount()).toBe(0);
    expect(existsSync(storageFile("after-backup.txt"))).toBe(true);
    expect(readdirSync(storageFile("backups")).filter((n) => n.startsWith("backup-")).sort()).toEqual([a, b, c, d]);
  });

  it("restores for real: the row and the file come back, what was made after is gone, a safety backup of the state before is kept, and no backup was pruned", async () => {
    // 7 newer-named folders so a pruning safety copy WOULD delete the oldest one, which is the very backup being restored
    for (let h = 10; h < 17; h++) {
      mkdirSync(storageFile("backups", NAME(h)), { recursive: true });
      writeFileSync(storageFile("backups", NAME(h), "db.dump"), "placeholder");
    }
    const r = await restoreBackup(db.ownerPool, { name: a, yes: true }, { ...deps, now: at(30) });
    expect(r.ok, r.ok ? "" : r.reason).toBe(true);
    if (!r.ok) return;
    expect(r.dryRun).toBe(false);
    expect(r.steps.join("\n")).toMatch(/The database was restored/);
    expect(r.steps.join("\n")).toMatch(/The files were restored/);

    // what was backed up is back
    expect(await videoCount()).toBe(1);
    expect((await db.ownerPool.query("select topic from videos where id = $1", [videoId])).rows[0].topic).toBe("Why the sea is salty");
    expect(readFileSync(storageFile("videos", videoId, "scenes.json"), "utf8")).toBe('{"scenes":"before"}');
    // what was made after is gone
    expect(existsSync(storageFile("after-backup.txt"))).toBe(false);
    // the backups folder is untouched, the oldest backup (the one restored) is still there, and the safety backup holds the state from before the restore
    expect(existsSync(storageFile("backups", a, "db.dump"))).toBe(true);
    expect(r.safetyCopy).toBe(NAME(30));
    expect(await tarList(storageFile("backups", NAME(30), "storage.tar.gz"))).toMatch(/after-backup\.txt/);
    expect(readdirSync(storageFile()).filter((n) => n.startsWith(".restore-"))).toEqual([]); // no leftover temp folder
    // the restore left a trace in the audit log
    const audit = (await db.ownerPool.query("select detail from audit_log where event = 'backup.restored'")).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].detail).toEqual({ name: a, safetyCopy: NAME(30) });
    // the roles still work: the app role can read what was restored (privileges came back with the dump)
    const check = createPool(appUrl);
    try {
      expect(Number((await check.query("select count(*)::int n from videos")).rows[0].n)).toBe(1);
    } finally {
      await check.end();
    }
  }, 300_000);

  it("restoring the safety backup undoes the restore (the state from just before it)", async () => {
    const r = await restoreBackup(db.ownerPool, { name: NAME(30), yes: true, skipSafetyCopy: true }, { ...deps, now: at(31) });
    expect(r.ok, r.ok ? "" : r.reason).toBe(true);
    expect(await videoCount()).toBe(0); // the state before the first restore had no video
    expect(existsSync(storageFile("after-backup.txt"))).toBe(true);
    expect(readFileSync(storageFile("videos", videoId, "scenes.json"), "utf8")).toBe('{"scenes":"after"}');
    expect(!r.ok ? null : r.safetyCopy).toBeUndefined(); // skipped, as asked
  }, 300_000);
});
