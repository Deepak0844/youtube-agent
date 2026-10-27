import { createHash } from "node:crypto";
import { gateById, type GateId } from "@/server/core/gates";

// Canonical JSON + SHA-256 so an approval can be bound to exactly the content the owner saw. Pure: no IO.

function canon(v: unknown, path: string): string {
  if (v === null) return "null";
  switch (typeof v) {
    case "string":
      return JSON.stringify(v.normalize("NFC"));
    case "boolean":
      return v ? "true" : "false";
    case "number":
      if (!Number.isFinite(v)) throw new Error(`canonicalJson: non-finite number at ${path}`);
      return JSON.stringify(v);
    case "object": {
      if (Array.isArray(v)) return `[${v.map((x, i) => canon(x, `${path}[${i}]`)).join(",")}]`;
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) throw new Error(`canonicalJson: non-plain object at ${path}`);
      const o = v as Record<string, unknown>;
      const keys = Object.keys(o).map((k) => [k.normalize("NFC"), k] as const);
      keys.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      for (let i = 1; i < keys.length; i++) if (keys[i]![0] === keys[i - 1]![0]) throw new Error(`canonicalJson: duplicate key after NFC at ${path}`);
      return `{${keys.map(([nk, k]) => `${JSON.stringify(nk)}:${canon(o[k], `${path}.${k}`)}`).join(",")}}`;
    }
    default:
      throw new Error(`canonicalJson: unsupported ${typeof v} at ${path}`);
  }
}

/** Sorted keys, no whitespace, strings NFC. Throws on NaN, Infinity, undefined, functions, bigint, symbols, class instances. */
export function canonicalJson(value: unknown): string {
  return canon(value, "$");
}

export function sha256Hex(s: string | Uint8Array): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Hash of exactly the parts a gate covers (GATES[gate].hashCovers). A missing or extra key throws. */
export function gateHash(gate: GateId, parts: Record<string, string>): string {
  const covers = gateById(gate).hashCovers;
  const missing = covers.filter((k) => !Object.hasOwn(parts, k));
  if (missing.length) throw new Error(`gateHash(${gate}): missing ${missing.join(", ")}`);
  const extra = Object.keys(parts).filter((k) => !covers.includes(k));
  if (extra.length) throw new Error(`gateHash(${gate}): extra ${extra.join(", ")}`);
  return sha256Hex(canonicalJson({ gate, parts }));
}
