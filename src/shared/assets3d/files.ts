import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Entry3d } from "./schema";

export type FileState = "ok" | "missing" | "bad";

export function sha256Hex(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

// Is the file on disk the one the manifest promises (same size and sha256)?
export async function checkFile(dir: string, e: Pick<Entry3d, "file" | "sha256" | "bytes">): Promise<FileState> {
  let buf: Buffer;
  try {
    buf = await readFile(path.join(dir, e.file));
  } catch {
    return "missing";
  }
  return buf.length === e.bytes && sha256Hex(buf) === e.sha256 ? "ok" : "bad";
}
