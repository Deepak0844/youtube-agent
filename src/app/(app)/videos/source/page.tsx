import { Suspense } from "react";
import { requireOwner } from "@/lib/auth/require-owner";
import { PageSkeleton } from "@/ui/states/page-skeleton";
import { SourceUpload } from "./source-upload";

export const metadata = { title: "Cut clips from your video" };

// Clip Factory: bring your own video (an mp4, mov, mkv or webm of up to 1 GB and 30 minutes) and cut clips from it. The video is listened to on this
// computer (VoiceStudio speech-to-text); nothing leaves it and nothing is published.
export default function ClipSource() {
  return (
    <Suspense fallback={<PageSkeleton variant="form" />}>
      <Owned />
    </Suspense>
  );
}

async function Owned() {
  await requireOwner();
  return (
    <div className="flex min-w-0 max-w-2xl flex-col gap-layout">
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="text-page-title font-semibold tracking-tight">Cut clips from your video</h1>
        <p className="m-0 text-body text-muted">Upload a video with clear speech. The app prepares it, listens to it on this computer with VoiceStudio, and then you can cut short clips from it on its Clips tab.</p>
      </div>
      <SourceUpload />
    </div>
  );
}
