import { configureAuthAdmission } from "@/server/db/auth";

// Reads AUTH_MAX_IN_FLIGHT / AUTH_MAX_PER_IP once per module instance (defaults live in auth.ts: 3 and 1).
let done = false;
export function ensureAuthConfigured(): void {
  if (done) return;
  done = true;
  const n = (v: string | undefined) => (v && /^[1-9]\d{0,3}$/.test(v) ? Number(v) : undefined);
  const maxInFlightAuth = n(process.env.AUTH_MAX_IN_FLIGHT);
  const maxPerIp = n(process.env.AUTH_MAX_PER_IP);
  if (maxInFlightAuth !== undefined || maxPerIp !== undefined) configureAuthAdmission({ maxInFlightAuth, maxPerIp });
}
