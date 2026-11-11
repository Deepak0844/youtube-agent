// `npm run backup:list` and `npm run backup:restore -- <backup name | --latest> [--yes] [--skip-safety-copy]`.
//   --list                 the backups there are, newest first (changes nothing)
//   <name> or --latest     checks that backup and says what it would do (changes nothing)
//   ... --yes              really restores it (stop the app and the worker first; a safety backup of the current state is made first)
// Reads the database address from MIGRATE_DATABASE_URL (the owner role), else DATABASE_URL. Exit code 0 = fine, 1 = refused or failed, 2 = wrong use.
import pg from "pg";
import { describeListItem, listBackups, restoreBackup } from "@/server/db/backup-restore";
import { storageRoot } from "@/server/storage/paths";

const USAGE = [
  "Usage:",
  "  npm run backup:list",
  "  npm run backup:restore -- --latest            (look only)",
  "  npm run backup:restore -- <backup name>       (look only)",
  "  npm run backup:restore -- --latest --yes      (restore; stop the app and the worker first)",
  "Add --skip-safety-copy only if the current state is already lost.",
].join("\n");

async function main(argv: string[]): Promise<number> {
  const args = argv.filter((a) => a !== "--");
  const flags = new Set(args.filter((a) => a.startsWith("--") && a !== "--latest"));
  const rest = args.filter((a) => !a.startsWith("--") || a === "--latest");
  const known = new Set(["--list", "--yes", "--skip-safety-copy"]);
  if ([...flags].some((f) => !known.has(f))) {
    console.error(USAGE);
    return 2;
  }

  if (flags.has("--list")) {
    const all = await listBackups();
    if (all.length === 0) console.log("There are no backups yet.");
    for (const b of all) console.log(describeListItem(b));
    return 0;
  }

  if (rest.length !== 1) {
    console.error(USAGE);
    return 2;
  }
  const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error("No database address is set (MIGRATE_DATABASE_URL or DATABASE_URL).");
    return 1;
  }
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const r = await restoreBackup(pool, { name: rest[0]!, yes: flags.has("--yes"), skipSafetyCopy: flags.has("--skip-safety-copy") }, { root: storageRoot() });
    for (const s of r.steps) console.log(s);
    if (!r.ok) {
      console.error(r.reason);
      return 1;
    }
    return 0;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  () => {
    console.error("The restore command could not run.");
    process.exit(1);
  },
);
