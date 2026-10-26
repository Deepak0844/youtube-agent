// Pure ip normalisation for lock keys and admission keys. Not full IPv6 canonicalisation.
export const UNKNOWN_IP = "unknown";
const MAX = 64;

export function normalizeIp(ip: unknown): string {
  if (typeof ip !== "string") return UNKNOWN_IP;
  let s = ip.trim().toLowerCase();
  const z = s.indexOf("%");
  if (z >= 0) s = s.slice(0, z);
  if (s.length === 0) return UNKNOWN_IP;
  const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
  if (dotted) s = dotted[1]!;
  else {
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(s);
    if (hex) {
      const a = parseInt(hex[1]!, 16);
      const b = parseInt(hex[2]!, 16);
      s = `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
    }
  }
  return s.slice(0, MAX);
}
