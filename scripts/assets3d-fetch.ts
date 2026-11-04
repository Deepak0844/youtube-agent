import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { acceptPacked, checkFile, isPacked, sha256Hex, sourceHash } from "@/shared/assets3d/files";
import { Manifest, type Entry3d } from "@/shared/assets3d/schema";

// npm run assets3d:fetch   downloads every manifest file into assets3d/files/ (skips good ones, checks sha256)
// npm run assets3d:verify  only checks the files already there, downloads nothing
const ROOT = path.join(process.cwd(), "assets3d");
const DIR = path.join(ROOT, "files");
const UA = "yt-studio-assets3d/1.0 (polite sequential fetch)";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get(url: string): Promise<Buffer> {
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return Buffer.from(await r.arrayBuffer());
}

// Poly Haven models come as .gltf + .bin + textures; the manifest holds the single .glb we packed from them.
async function downloadPacked(e: Entry3d): Promise<{ glb: Buffer; source: string }> {
  const slug = /polyhaven\.com\/a\/([a-z0-9_]+)/i.exec(e.url)?.[1];
  if (!slug) throw new Error("cannot find the Poly Haven name in url");
  const files = (await (await fetch(`https://api.polyhaven.com/files/${slug}`, { headers: { "User-Agent": UA } })).json()) as {
    gltf: Record<string, { gltf: { url: string; include: Record<string, { url: string }> } }>;
  };
  const g = files.gltf["1k"].gltf;
  const tmp = await mkdtemp(path.join(tmpdir(), "assets3d-"));
  try {
    const gltf = await get(g.url);
    const extras: Record<string, Buffer> = {};
    await writeFile(path.join(tmp, "model.gltf"), gltf);
    for (const [rel, inc] of Object.entries(g.include)) {
      await mkdir(path.dirname(path.join(tmp, rel)), { recursive: true });
      extras[rel] = await get(inc.url);
      await writeFile(path.join(tmp, rel), extras[rel]);
      await sleep(200);
    }
    const [{ NodeIO }, { ALL_EXTENSIONS }] = await Promise.all([import("@gltf-transform/core"), import("@gltf-transform/extensions")]);
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
    const glb = Buffer.from(await io.writeBinary(await io.read(path.join(tmp, "model.gltf"))));
    await io.readBinary(new Uint8Array(glb)); // must parse again
    return { glb, source: sourceHash(gltf, extras) };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const verifyOnly = process.argv.includes("--verify");
  const { entries } = Manifest.parse(JSON.parse(await readFile(path.join(ROOT, "manifest.json"), "utf8")));
  await mkdir(DIR, { recursive: true });
  const n = { ok: 0, warn: 0, downloaded: 0, missing: 0, bad: 0, failed: 0 };
  const warned: string[] = [];
  for (const e of entries) {
    const state = await checkFile(DIR, e);
    if (state === "ok" || state === "warn") {
      n[state] += 1;
      if (state === "warn") warned.push(e.file);
      continue;
    }
    if (verifyOnly) {
      n[state] += 1;
      process.stderr.write(`${state}: ${e.file}\n`);
      continue;
    }
    try {
      let buf: Buffer;
      if (isPacked(e)) {
        const r = await downloadPacked(e);
        const verdict = acceptPacked(e, r.source, r.glb);
        if (verdict === "fail") throw new Error("download does not match source_sha256, or the repack is not a sane GLB");
        if (verdict === "warn") warned.push(e.file);
        buf = r.glb;
      } else {
        buf = await get(e.download_url);
        if (buf.length !== e.bytes || sha256Hex(buf) !== e.sha256 || sha256Hex(buf) !== e.source_sha256) throw new Error("downloaded file does not match the manifest sha256");
      }
      await writeFile(path.join(DIR, e.file), buf);
      n.downloaded += 1;
      await sleep(400);
    } catch (err) {
      n.failed += 1;
      process.stderr.write(`failed: ${e.file}: ${err instanceof Error ? err.message : "unknown error"}\n`);
    }
  }
  if (warned.length) process.stderr.write(`warning: repacked hash differs from the manifest (library version?), accepted: ${warned.join(", ")}\n`);
  process.stdout.write(`assets3d: ${entries.length} entries, ${n.ok + n.warn} already ok (${n.warn} with a repack warning), ${n.downloaded} downloaded, ${n.missing} missing, ${n.bad} bad, ${n.failed} failed\n`);
  if (n.missing + n.bad + n.failed > 0) process.exitCode = 1;
}
void main();
