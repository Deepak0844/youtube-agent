import { getPool } from "@/server/db/pool";
import { creditsForVideo } from "@/server/db/video-assets";

/** Montage at the video gate: who made each stock clip and under what licence, so the owner sees it before approving. */
export async function FootageCredits({ videoId }: { videoId: string }) {
  const lines = await creditsForVideo(getPool(), videoId);
  if (lines.length === 0) return null;
  return (
    <div data-testid="footage-credits" className="flex min-w-0 flex-col gap-1 rounded-card border border-border bg-surface p-pad">
      <h3 className="m-0 text-section font-medium">Footage credits</h3>
      <p className="m-0 text-small text-muted">All clips are free stock under the Pixabay Content License. Credit is not required; the lines are here for your records.</p>
      <ul className="m-0 flex list-none flex-col gap-1 p-0 text-body">{lines.map((l) => <li key={l} className="[overflow-wrap:anywhere]">{l}</li>)}</ul>
    </div>
  );
}
