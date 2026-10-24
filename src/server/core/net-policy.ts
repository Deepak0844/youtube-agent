import ipaddr from "ipaddr.js";

export type AddressClass =
  | "public"
  | "private"
  | "loopback"
  | "linklocal"
  | "metadata"
  | "cgnat"
  | "docker"
  | "multicast"
  | "reserved"
  | "invalid";

// Docker bridge default and OrbStack defaults; verify against the host in Task 6.
export const DOCKER_RANGES: string[] = ["172.17.0.0/16", "192.168.215.0/24", "192.168.228.0/23", "198.19.248.0/21"];

const DOCKER_CIDRS = DOCKER_RANGES.map((cidr) => ipaddr.IPv4.parseCIDR(cidr));
const METADATA_V6 = ipaddr.IPv6.parse("fd00:ec2::254");

const NUMBER = /^(?:0x[0-9a-f]+|0[0-7]*|[1-9][0-9]*)$/i;

// Resolvers (inet_aton) accept 1-4 dotted parts, each decimal/0x-hex/0-octal, the last part
// filling the remaining bytes. Rewrite those to dotted quad; undefined if not that shape.
function normaliseLegacyIPv4(input: string): string | undefined {
  const parts = input.split(".");
  if (parts.length > 4 || !parts.every((p) => NUMBER.test(p))) return undefined;
  const nums = parts.map((p) => Number(p.length > 1 && p.startsWith("0") && !/^0x/i.test(p) ? `0o${p.slice(1)}` : p));
  const last = nums.pop() as number;
  if (nums.some((n) => n > 255) || last >= 256 ** (4 - nums.length)) return undefined;
  const bytes = [...nums];
  for (let i = 4 - nums.length - 1; i >= 0; i--) bytes.push(Math.floor(last / 256 ** i) % 256);
  return bytes.join(".");
}

function classifyV4(addr: ipaddr.IPv4): AddressClass {
  if (addr.toString() === "169.254.169.254") return "metadata";
  if (DOCKER_CIDRS.some((cidr) => addr.match(cidr))) return "docker";
  switch (addr.range()) {
    case "unicast":
      return "public";
    case "private":
      return "private";
    case "loopback":
      return "loopback";
    case "linkLocal":
      return "linklocal";
    case "carrierGradeNat":
      return "cgnat";
    case "multicast":
      return "multicast";
    default:
      return "reserved";
  }
}

export function classifyAddress(address: string): AddressClass {
  if (ipaddr.IPv6.isValid(address)) {
    const v6 = ipaddr.IPv6.parse(address);
    if (v6.isIPv4MappedAddress()) return classifyV4(v6.toIPv4Address());
    if (v6.toNormalizedString() === METADATA_V6.toNormalizedString()) return "metadata";
    switch (v6.range()) {
      case "unicast":
        return "public";
      case "uniqueLocal":
        return "private";
      case "loopback":
        return "loopback";
      case "linkLocal":
        return "linklocal";
      case "multicast":
        return "multicast";
      default:
        return "reserved";
    }
  }
  const dotted = normaliseLegacyIPv4(address);
  if (dotted === undefined || !ipaddr.IPv4.isValidFourPartDecimal(dotted)) return "invalid";
  return classifyV4(ipaddr.IPv4.parse(dotted));
}

export function isPublicAddress(address: string): boolean {
  return classifyAddress(address) === "public";
}
