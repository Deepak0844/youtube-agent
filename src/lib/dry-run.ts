/** Marker on videos made by the queue's dry-run button. The production worker refuses these videos (src/worker/handlers.ts). */
export const DRY_RUN_NOTES = "dry run";

/**
 * The dry-run starter exists only when the owner set ENGINE_DRY_RUN=1 outside production. The web action also runs the
 * database guard (dryRunRefusal: throwaway database, no provider key) before it starts anything.
 */
export function dryRunAllowed(env: Record<string, string | undefined> = process.env): boolean {
  return env.ENGINE_DRY_RUN === "1" && env.NODE_ENV !== "production";
}
