import { Suspense } from "react";
import { requireOwner } from "@/lib/auth/require-owner";
import { renderLimitNote } from "@/server/core/scale3d-view";
import { scene3dNativeNote } from "@/server/core/scene3d-view";
import { checkNativeRenderReady } from "@/server/providers/renderer/native-preflight";
import { getEngineConfig } from "@/server/db/engine-config";
import { getPool } from "@/server/db/pool";
import { getSetting } from "@/server/db/settings";
import { LONG_HARD_MAX_MINUTES } from "@/server/core/long-form";
import { Skeleton } from "@/ui/primitives/skeleton";
import { NewForm } from "./new-form";

export default function NewVideo() {
  return (
    <Suspense fallback={<Skeleton aria-hidden className="h-96 w-full rounded-card" />}>
      <Owned />
    </Suspense>
  );
}

async function Owned() {
  await requireOwner();
  const config = await getEngineConfig(getPool());
  const maxLongMinutes = Math.min(Number(await getSetting(getPool(), "video.max_long_minutes")), LONG_HARD_MAX_MINUTES);
  const limitNote = renderLimitNote(config.render.timeoutS);
  // Read only: the preflight looks at this Mac (sandbox, Remotion, Chrome shell, disk); nothing is changed or downloaded.
  const nativeNote = scene3dNativeNote(config.render.native3d, config.render.native3d ? await checkNativeRenderReady().catch(() => ({ ready: false, message: "The readiness check failed." })) : null);
  return (
    <div className="flex min-w-0 flex-col gap-layout">
      <header className="flex flex-col gap-1">
        <h1 className="text-page-title font-semibold tracking-tight">New video</h1>
        <p className="m-0 max-w-prose text-body text-muted">Say what the video is about. The studio writes a script and stops to ask you before it spends money or publishes anything.</p>
      </header>
      <NewForm scaleLimitNote={limitNote} scene3dNote={nativeNote} maxLongMinutes={maxLongMinutes} />
    </div>
  );
}
