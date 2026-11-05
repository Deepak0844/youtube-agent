import { KnownFailure } from "@/server/core/paid-call";
import type { AttemptHandler } from "./attempt";
import type { StageDeps } from "./deps";

/** Placeholder until the author step lands (next commit of this slice). */
export function scene3dAuthorAttempt(_deps: StageDeps): AttemptHandler {
  return async () => {
    throw new KnownFailure("The 3D scene author is not built yet.");
  };
}
