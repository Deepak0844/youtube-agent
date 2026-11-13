import { Suspense } from "react";
import { requireOwner } from "@/lib/auth/require-owner";
import { getPool } from "@/server/db/pool";
import { resolveRoute } from "@/server/db/media-registry";
import { characterCandidates } from "@/server/db/video-characters";
import { listAccounts } from "@/server/db/youtube-channels";
import { maxLongMinutes as readMaxLongMinutes } from "@/server/db/system-settings";
import { LONG_HARD_MAX_MINUTES } from "@/server/core/long-form";
import { PageSkeleton } from "@/ui/states/page-skeleton";
import { NewForm } from "./new-form";

export const metadata = { title: "New video" };

export default function NewVideo({ searchParams }: PageProps<"/videos/new">) {
  return (
    <Suspense fallback={<PageSkeleton variant="form" />}>
      <Owned searchParams={searchParams} />
    </Suspense>
  );
}

async function Owned({ searchParams }: Pick<PageProps<"/videos/new">, "searchParams">) {
  await requireOwner();
  const initialFormat = (await searchParams).format === "long" ? "long" : "short"; // "New long video" links here with ?format=long
  const maxLongMinutes = Math.min(await readMaxLongMinutes(getPool()), LONG_HARD_MAX_MINUTES);
  // AI videos: say plainly when no provider and model are chosen yet, and offer the library pictures that can be a character.
  const route = await resolveRoute(getPool(), "video", { format: "short", videoKind: "ai" }).catch(() => null);
  const aiNote = route?.model ? null : "No AI video provider and model are chosen yet (Settings > Providers). The script and the narration can be made, but the clips wait for one.";
  const characters = await characterCandidates(getPool()).catch(() => []);
  // Connected channels for the optional Channel picker; each carries its default language and look to prefill the form.
  const channels = (await listAccounts(getPool()).catch(() => [])).flatMap((a) => a.channels).map((c) => ({ id: c.channelId, title: c.title, language: c.settings.language, style: c.settings.defaultStyle }));
  return (
    <div className="flex min-w-0 flex-col gap-layout">
      <header className="flex flex-col gap-1">
        <h1 className="text-page-title font-semibold tracking-tight">New video</h1>
        <p className="m-0 max-w-prose text-body text-muted">Say what the video is about. The studio writes a script and stops to ask you before it spends money or publishes anything.</p>
      </header>
      <NewForm initialFormat={initialFormat} maxLongMinutes={maxLongMinutes} aiNote={aiNote} characters={characters} channels={channels} />
    </div>
  );
}
