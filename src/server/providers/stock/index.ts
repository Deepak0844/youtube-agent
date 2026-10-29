import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { rejectionMessage, sniff, SNIFF_HEAD_BYTES } from "@/server/core/sniff";
import type { MediaArtifact } from "@/server/providers/media-types";
import { safeFetch } from "@/server/providers/net/safe-fetch";
import type { Db } from "@/server/db/stages";
import { coverrStock } from "./coverr";
import { ownStock } from "./own";
import { pexelsStock } from "./pexels";
import { pixabayStock } from "./pixabay";

export type StockHit = {
  id: string; title: string; url: string; pageUrl: string; author?: string; licence: string; attribution?: string;
  width: number; height: number; seconds?: number;
};
export type StockSearch = { query: string; kind: "image" | "video"; orientation: "portrait" | "landscape"; count: number; minSeconds?: number };
export type StockCtx = { attemptDir: string; signal: AbortSignal };
export interface StockProvider {
  search(a: StockSearch): Promise<StockHit[]>;
  fetch(ctx: StockCtx, hit: StockHit): Promise<MediaArtifact>;
}

/** A message safe to show the owner: never contains a URL or a key. */
export class StockError extends Error {}

export type StockFetcher = (url: string, init?: RequestInit) => Promise<Response>;
export interface StockDeps {
  /** Reads the saved key for this provider at call time (never cached); null when none is saved. */
  getKey: () => Promise<string | null>;
  fetcher?: StockFetcher;
  /** resolvePath must map a storageRef to a file inside the asset storage root (the caller owns that containment). */
  own?: { db: Db; resolvePath: (storageRef: string) => string };
}

// Hosts are fixed per provider. API host serves the search; CDN hosts are the only places a download may come from.
export type StockHosts = { api: string; cdn: readonly string[] };

export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
export const PORTRAIT_MAX_WIDTH = 1080;

export const defaultFetcher: StockFetcher = (url, init) => safeFetch(url, { ...init, redirect: "manual" }, { mode: "indirect", maxRedirects: 0, timeoutMs: 30_000 });

export function allowedUrl(url: string, hosts: readonly string[]): URL {
  let u: URL;
  try { u = new URL(url); } catch { throw new StockError("That download address is not an allowed stock host."); }
  if (u.protocol !== "https:" || u.username || u.password || !hosts.includes(u.hostname)) throw new StockError("That download address is not an allowed stock host.");
  return u;
}

export function failMessage(name: string, status: number): StockError {
  if (status === 401 || status === 403) return new StockError(`${name} did not accept the saved key. Check it on the Keys page.`);
  if (status === 429) return new StockError(`${name} says too many requests. Try again later.`);
  return new StockError(`${name} answered with an error (${status}).`);
}

export async function requireKey(deps: StockDeps, name: string): Promise<string> {
  const key = await deps.getKey();
  if (!key) throw new StockError(`Save your ${name} key on the Keys page first.`);
  return key;
}

/** The widest file that fits the orientation and the width cap (portrait 1080, landscape 1920); null when none fits. */
export function pickFile<T extends { width: number; height: number }>(files: readonly T[], orientation: StockSearch["orientation"]): T | null {
  const cap = orientation === "portrait" ? PORTRAIT_MAX_WIDTH : 1920;
  const fit = files.filter((f) => f.width > 0 && (orientation === "portrait" ? f.height > f.width : f.width >= f.height) && f.width <= cap);
  return fit.sort((a, b) => b.width - a.width)[0] ?? null;
}

/** A hit with no licence string is never offered. */
export const licensed = (hits: StockHit[], a: StockSearch): StockHit[] =>
  hits.filter((h) => h.licence.trim() !== "" && (a.minSeconds === undefined || (h.seconds ?? 0) >= a.minSeconds)).slice(0, a.count);

const safeId = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60);

/** Downloads one file into ctx.attemptDir: size-capped while streaming, then checked by magic bytes. Writes `<file>.licence.txt` beside it. */
export async function downloadStock(deps: StockDeps, ctx: StockCtx, name: string, id: string, hit: StockHit, hosts: readonly string[]): Promise<MediaArtifact> {
  const url = allowedUrl(hit.url, hosts);
  const kind = /\.(mp4|webm)$/i.test(url.pathname) ? "video" : "image";
  const max = kind === "video" ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  const res = await (deps.fetcher ?? defaultFetcher)(url.href, { signal: ctx.signal, redirect: "manual" });
  if (!res.ok || !res.body) { await res.body?.cancel().catch(() => undefined); throw failMessage(name, res.status); }
  if (Number(res.headers.get("content-length") ?? 0) > max) { await res.body.cancel(); throw new StockError("That file is too big."); }

  const tmp = path.join(ctx.attemptDir, `${id}-${safeId(hit.id)}.part`);
  const out = createWriteStream(tmp);
  const hash = createHash("sha256");
  let bytes = 0;
  const head: number[] = [];
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      bytes += chunk.length;
      if (bytes > max) throw new StockError("That file is too big.");
      if (head.length < SNIFF_HEAD_BYTES) head.push(...chunk.subarray(0, SNIFF_HEAD_BYTES - head.length));
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise<void>((r) => out.once("drain", () => r()));
    }
    await new Promise<void>((r, j) => out.end((e: Error | null | undefined) => (e ? j(e) : r())));
    const ext = extensionFor(Uint8Array.from(head), kind);
    const final = path.join(ctx.attemptDir, `${id}-${safeId(hit.id)}.${ext}`);
    await rename(tmp, final);
    const licence = hit.licence;
    await writeFile(`${final}.licence.txt`, [`Licence: ${licence}`, hit.attribution ? `Credit: ${hit.attribution}` : null, hit.author ? `Author: ${hit.author}` : null, `Source: ${hit.pageUrl}`].filter(Boolean).join("\n") + "\n");
    return {
      path: final, bytes, sha256: hash.digest("hex"), width: hit.width, height: hit.height, ...(hit.seconds !== undefined ? { durationS: hit.seconds } : {}),
      // Stock is free: the quote is 0.
      provenance: { provider: id, params: { id: hit.id, title: hit.title, author: hit.author ?? null }, priceMicroUsd: 0, quoted: true, licence, sourceUrl: hit.pageUrl, ...(hit.attribution ? { attribution: hit.attribution } : {}) },
    };
  } catch (e) {
    out.destroy();
    await rm(tmp, { force: true });
    throw e;
  }
}

// Images: the Task 16 sniffer decides. Videos: the sniffer calls MP4/WebM "video" and refuses them for uploads, so here
// that verdict is accepted only when the signature is MP4 (ftyp) or WebM (EBML); web page code and SVG stay refused.
function extensionFor(head: Uint8Array, kind: "image" | "video"): string {
  const s = sniff(head);
  if ("kind" in s) {
    if (kind === "image" && s.kind === "image") return ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" } as Record<string, string>)[s.mime] ?? "bin";
    throw new StockError(kind === "video" ? "That file is not a video." : "That file is not a picture.");
  }
  if (kind === "video" && s.rejected === "video") {
    if (head.length >= 8 && String.fromCharCode(...head.subarray(4, 8)) === "ftyp") return "mp4";
    if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return "webm";
  }
  throw new StockError(rejectionMessage(s.rejected));
}

export function createStockProvider(id: string, deps: StockDeps): StockProvider {
  switch (id) {
    case "pexels": return pexelsStock(deps);
    case "pixabay": return pixabayStock(deps);
    case "coverr": return coverrStock(deps);
    case "own_stock": return ownStock(deps);
    default: throw new StockError(`Unknown stock provider "${id.slice(0, 40)}".`);
  }
}
