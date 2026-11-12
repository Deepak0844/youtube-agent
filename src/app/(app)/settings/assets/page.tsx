import { Suspense } from "react";
import { PageSkeleton } from "@/ui/states/page-skeleton";
import { requireOwner } from "@/lib/auth/require-owner";
import { loadAssetSettings } from "@/server/db/asset-settings";
import { getPool } from "@/server/db/pool";
import { AssetSettingsForm } from "./asset-settings-form";
import { RetentionPanel } from "./retention-panel";

export const metadata = { title: "Asset settings" };

// Reads the session (cookies), so it sits inside <Suspense> with a static frame.
export default function AssetSettings() {
  return (
    <Suspense fallback={<PageSkeleton variant="form" />}>
      <Owned />
    </Suspense>
  );
}

async function Owned() {
  await requireOwner();
  const view = await loadAssetSettings(getPool());
  return (
    <div className="grid min-w-0 gap-layout xl:grid-cols-2 xl:items-start">
      <h1 className="text-page-title font-semibold tracking-tight xl:col-span-2">Asset settings</h1>
      <section aria-labelledby="cleanup-h" className="rounded-card border border-border bg-surface p-pad">
        <h2 id="cleanup-h" className="text-title font-semibold">Clean-up and upload limits</h2>
        <p className="mt-1 mb-2 max-w-[60ch] text-body text-muted">
          Uploads are removed some days after the last video that uses them is finished. Files marked Keep and files pinned to a
          series are never removed. Raising a limit lets bigger files in, so every change is written to the audit log.
        </p>
        <p role="note" className="mb-5 max-w-[60ch] rounded-card bg-pill-warning-bg p-4 text-body text-pill-warning-ink">
          Removing unused library files after the days below is not scheduled yet; nothing in your library is deleted on that
          day. Only the working files of videos already uploaded to YouTube are cleaned up (see the next section).
        </p>
        <AssetSettingsForm view={view} />
      </section>
      <section aria-labelledby="retention-h" className="flex flex-col gap-3 rounded-card border border-border bg-surface p-pad">
        <h2 id="retention-h" className="text-title font-semibold">Clean up uploaded videos</h2>
        <p className="max-w-[60ch] text-body text-muted">
          After a video has been on YouTube for the number of days above, its working files (drafts, narration pieces, scratch
          folders) are deleted and its unshared pictures go to the trash. The final video, Keep files and imported files stay. The
          worker also does this on its own every few hours. Look first, then delete.
        </p>
        <RetentionPanel />
      </section>
    </div>
  );
}
