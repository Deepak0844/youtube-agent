/** The dry-run starter exists only in development builds, or when the owner sets ENGINE_DRY_RUN=1. A normal production build refuses it. */
export function dryRunAllowed(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV !== "production" || env.ENGINE_DRY_RUN === "1";
}
