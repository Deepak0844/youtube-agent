import { describeBackup } from "@/server/core/backup";
import { lastBackup } from "@/server/db/backup";
import { getPool } from "@/server/db/pool";
import { Button } from "@/ui/primitives/button";
import { backUpNowAction } from "./backup-actions";

// Server component: reads the stored result of the last run.
export async function BackupSection() {
  const view = describeBackup(await lastBackup(getPool()));
  return (
    <section aria-labelledby="backup-h" className="rounded-card bg-surface p-pad">
      <h2 id="backup-h" className="text-title font-semibold">Backups</h2>
      <p className="mt-1 mb-4 max-w-[60ch] text-body text-muted">
        A copy of the database and the storage folder, kept in the backups folder inside storage. The newest 7 are kept.
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
    </section>
  );
}
