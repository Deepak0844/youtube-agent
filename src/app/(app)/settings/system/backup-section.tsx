import { describeBackup } from "@/server/core/backup";
import { extraBackupDir, lastBackup } from "@/server/db/backup";
import { getPool } from "@/server/db/pool";
import { Button } from "@/ui/primitives/button";
import { backUpNowAction } from "./backup-actions";
import { ExtraDirForm } from "./extra-dir-form";

// Server component: reads the stored result of the last run.
export async function BackupSection() {
  const db = getPool();
  const [view, extra] = await Promise.all([lastBackup(db).then(describeBackup), extraBackupDir(db)]);
  return (
    <section aria-labelledby="backup-h" className="rounded-card border border-border bg-surface p-pad">
      <h2 id="backup-h" className="text-title font-semibold">Backups</h2>
      <p className="mt-1 mb-4 max-w-[60ch] text-body text-muted">
        A copy of the database and the storage folder, made automatically every 6 hours (an hour after a failed one) and kept in the backups folder inside storage. The newest 7 are kept.
      </p>
      {view.tone === "failed" ? (
        <p role="note" data-testid="backup-failed" className="mb-4 max-w-[60ch] rounded-card bg-pill-negative-bg p-4 text-body text-pill-negative-ink">
          <strong>Backup failed.</strong> {view.text}
        </p>
      ) : (
        <p data-testid="backup-last" className="mb-4 text-body text-muted">{view.text}</p>
      )}
      <form action={backUpNowAction}>
        <Button type="submit">Back up now</Button>
      </form>
      <h3 className="mt-6 mb-1 text-body font-semibold">Extra copy</h3>
      <p className="mb-3 max-w-[60ch] text-small text-muted">Optional: also copy every backup to a folder you name, such as an external drive (on a Mac it starts with /Volumes/). Off until you set one. If the app&apos;s disk fails, the backups inside it fail with it, so an outside copy is worth having.</p>
      <ExtraDirForm current={extra} />
    </section>
  );
}
