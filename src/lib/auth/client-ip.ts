import { isIP } from "node:net";
import { normalizeIp, UNKNOWN_IP } from "@/server/core/ip";

// Client address for lockout and admission keys.
// Next 16 exposes NO socket address to route handlers/server components (`request.ip` was removed in 15). `next start`
// only does `req.headers['x-forwarded-for'] ??= socket.remoteAddress` (base-server.js), i.e. a header the CLIENT sent
// wins, so it can never be trusted on its own. Therefore:
//  - default: do not read any header; the address is 'unknown' (one shared bucket, never "known-good");
//  - TRUST_PROXY=1 (a reverse proxy we run sits in front and APPENDS to x-forwarded-for): take the RIGHTMOST entry, the
//    one our proxy wrote. The raw leftmost value is client-supplied and is never used. Must be a valid IP, else 'unknown'.
export function clientIpFrom(headers: Pick<Headers, "get">, o: { trustProxy: boolean }): string {
  if (!o.trustProxy) return UNKNOWN_IP;
  const raw = headers.get("x-forwarded-for");
  if (!raw || raw.length > 512) return UNKNOWN_IP;
  const last = raw.split(",").pop()!.trim();
  const ip = normalizeIp(last);
  return isIP(ip) !== 0 ? ip : UNKNOWN_IP;
}
