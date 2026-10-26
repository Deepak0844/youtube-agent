import { configureAuthAdmission } from "@/server/db/auth";

// Reads AUTH_MAX_IN_FLIGHT / AUTH_MAX_PER_IP once per process (flag on globalThis, because the admission state it
// configures is shared across Next bundles and a second configure call would reset the in-flight counters).
const DONE = Symbol.for("ytstudio.auth.configured");
export function ensureAuthConfigured(): void {
  const g = globalThis as unknown as Record<symbol, boolean | undefined>;
  if (g[DONE]) return;
  g[DONE] = true;
  const n = (v: string | undefined) => (v && /^[1-9]\d{0,3}$/.test(v) ? Number(v) : undefined);
  const maxInFlightAuth = n(process.env.AUTH_MAX_IN_FLIGHT);
  const maxPerIp = n(process.env.AUTH_MAX_PER_IP);
  if (maxInFlightAuth !== undefined || maxPerIp !== undefined) configureAuthAdmission({ maxInFlightAuth, maxPerIp });
}
