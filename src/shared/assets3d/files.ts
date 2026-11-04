import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Entry3d } from "./schema";

export type FileState = "ok" | "missing" | "bad" | "warn";
type Expect = Pick<Entry3d, "file" | "sha256" | "bytes" | "download_url">;

export function sha256Hex(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

// Poly Haven models are downloaded as .gltf + extra files and packed into one .glb by us.
export function isPacked(e: Pick<Entry3d, "download_url">): boolean {
  return e.download_url.endsWith(".gltf");
}

// sha256 of the original download of a packed model: the .gltf, then every extra file in path order.
export function sourceHash(gltf: Uint8Array, extras: Record<string, Uint8Array>): string {
  const h = createHash("sha256").update(gltf);
  for (const k of Object.keys(extras).sort()) h.update(extras[k]);
  return h.digest("hex");
}

export function looksLikeGlb(buf: Uint8Array): boolean {
  return buf.length > 12 && buf[0] === 0x67 && buf[1] === 0x6c && buf[2] === 0x54 && buf[3] === 0x46; // "glTF"
}

// A repacked file may differ byte for byte with another library version: that only warns, as long as it is still a sane GLB.
export function judgePacked(e: Pick<Entry3d, "sha256" | "bytes">, out: Uint8Array): "ok" | "warn" | "bad" {
  if (sha256Hex(out) === e.sha256) return "ok";
  return looksLikeGlb(out) && out.length <= 2 * e.bytes && out.length * 2 >= e.bytes ? "warn" : "bad";
}

// After downloading and repacking a model: the source hash must match (else fail); the repack hash may only warn.
export function acceptPacked(e: Pick<Entry3d, "sha256" | "bytes" | "source_sha256">, source: string, out: Uint8Array): "ok" | "warn" | "fail" {
  if (source !== e.source_sha256) return "fail";
  const j = judgePacked(e, out);
  return j === "bad" ? "fail" : j;
}

// Is the file on disk the one the manifest promises?
export async function checkFile(dir: string, e: Expect): Promise<FileState> {
  let buf: Buffer;
  try {
    buf = await readFile(path.join(dir, e.file));
  } catch {
    return "missing";
  }
  if (isPacked(e)) return judgePacked(e, buf);
  return buf.length === e.bytes && sha256Hex(buf) === e.sha256 ? "ok" : "bad";
}
