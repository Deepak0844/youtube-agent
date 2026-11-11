"use client";

import { ErrorState } from "@/ui/states/error-state";

// Any page in the app that throws while rendering lands here (spec §4.6.5). The shell around it keeps working.
export default function AppError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <ErrorState title="This page could not load" retry={reset} />;
}
