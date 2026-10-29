import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { RIGHTS_TEXT } from "@/server/core/asset-rules";
import { registerAsset } from "@/server/db/assets";
import { createStockProvider, StockError, type StockHit } from "@/server/providers/stock";
import { withTestDb, type TestDb } from "../support/db";

// Fixtures in tests/fixtures/stock are hand-written from public docs (header field `_unrecorded`). No network: a local
// server answers, and the test fetcher maps each provider's fixed https host onto it AFTER the provider checked the host.
const fx = (n: string) => readFileSync(path.join(process.cwd(), "tests/fixtures/stock", n), "utf8");
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(200, 2)]);
const HTML = Buffer.from("<html><script>alert(1)</script></html>");

let server: Server;
let base: string;
const hits: { url: string; auth?: string }[] = [];
let body: Record<string, Buffer | string> = {};
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "stock-"));
  server = createServer((req, res) => {
    hits.push({ url: req.url ?? "", auth: req.headers.authorization });
    const key = Object.keys(body).find((k) => (req.url ?? "").startsWith(k));
    if (!key) return void res.writeHead(404).end();
    res.writeHead(200).end(body[key]);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => void server.close());

const fetcher = (url: string, init?: RequestInit) => fetch(base + new URL(url).pathname + new URL(url).search, init);
const deps = (key: string | null = "k".repeat(24)) => ({ getKey: async () => key, fetcher });
const ctx = () => ({ attemptDir: mkdtempSync(path.join(dir, "a-")), signal: new AbortController().signal });
const hit = (o: Partial<StockHit>): StockHit => ({ id: "1", title: "t", url: "https://images.pexels.com/x.jpg", pageUrl: "https://www.pexels.com/photo/1/", licence: "Pexels License", width: 1080, height: 1920, ...o });

describe("stock providers", () => {
  it("portrait_file_chosen_and_capped_at_1080", async () => {
    body = { "/videos/search": fx("pexels-videos.json") };
    const px = createStockProvider("pexels", deps());
    const v = await px.search({ query: "sea", kind: "video", orientation: "portrait", count: 5 });
    expect(v.map((h) => [h.id, h.width, h.url])).toEqual([
      ["201", 1080, "https://videos.pexels.com/video-files/201/hd.mp4"],
      ["202", 1080, "https://videos.pexels.com/video-files/202/hd.mp4"],
    ]);
    expect((await px.search({ query: "sea", kind: "video", orientation: "portrait", count: 5, minSeconds: 10 })).map((h) => h.id)).toEqual(["201"]);
    body = { "/v1/search": fx("pexels-photos.json") };
    const [p] = await px.search({ query: "sea", kind: "image", orientation: "portrait", count: 5 });
    expect(p!.width).toBe(1080);
    expect(p!.height).toBe(1620);
    expect(p!.url).toContain("w=1080");
    body = { "/api/videos": fx("pixabay-videos.json") };
    const [pv] = await createStockProvider("pixabay", deps("1234567-" + "a".repeat(20))).search({ query: "sea", kind: "video", orientation: "portrait", count: 3 });
    expect([pv!.width, pv!.url]).toEqual([1080, "https://cdn.pixabay.com/video/401_medium.mp4"]);
    body = { "/api/": fx("pixabay-images.json") };
    const [pi] = await createStockProvider("pixabay", deps("1234567-" + "a".repeat(20))).search({ query: "sea", kind: "image", orientation: "portrait", count: 3 });
    expect([pi!.width, pi!.url]).toEqual([960, "https://pixabay.com/get/abc_960.jpg"]);
  });

  it("missing_key_and_unknown_provider_plain_errors", async () => {
    expect(() => createStockProvider("nope", deps())).toThrow(/Unknown stock provider/);
    await expect(createStockProvider("pexels", deps(null)).search({ query: "a", kind: "image", orientation: "portrait", count: 1 })).rejects.toThrow("Save your Pexels key on the Keys page first.");
    body = {};
    const err = await createStockProvider("pexels", deps("SECRETKEY1234567890ABCD")).search({ query: "a", kind: "image", orientation: "portrait", count: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(StockError);
    expect(String(err.message)).not.toContain("SECRETKEY");
  });

  it("hit_without_licence_dropped", async () => {
    body = { "/videos": fx("coverr-videos.json") };
    const out = await createStockProvider("coverr", deps()).search({ query: "sea", kind: "video", orientation: "portrait", count: 5 });
    expect(out.map((h) => h.id)).toEqual(["c1"]);
    expect(hits.at(-1)!.auth).toBe(`Bearer ${"k".repeat(24)}`);
  });

  it("free_providers_need_no_key_where_the_provider_allows", async () => {
    for (const [id, name] of [["pexels", "Pexels"], ["pixabay", "Pixabay"]] as const) {
      await expect(createStockProvider(id, deps(null)).search({ query: "a", kind: "image", orientation: "portrait", count: 1 })).rejects.toThrow(`Save your ${name} key on the Keys page first.`);
    }
  });

  it("import_writes_licence_note_with_provenance", async () => {
    body = { "/x.jpg": JPEG };
    const art = await createStockProvider("pexels", deps()).fetch(ctx(), hit({ author: "Ann Lee", attribution: "Photo by Ann Lee on Pexels" }));
    expect(art.provenance).toMatchObject({ provider: "pexels", priceMicroUsd: 0, quoted: true, licence: "Pexels License", attribution: "Photo by Ann Lee on Pexels", sourceUrl: "https://www.pexels.com/photo/1/" });
    expect(art.bytes).toBe(JPEG.length);
    const note = readFileSync(art.path + ".licence.txt", "utf8");
    expect(note).toContain("Pexels License");
    expect(note).toContain("Photo by Ann Lee on Pexels");
    expect(note).toContain("https://www.pexels.com/photo/1/");
  });

  it("download_host_sniff_and_size_are_enforced", async () => {
    const p = createStockProvider("pexels", deps());
    const c = ctx();
    await expect(p.fetch(c, hit({ url: "https://evil.example/x.jpg" }))).rejects.toThrow(/not an allowed/);
    await expect(p.fetch(c, hit({ url: "http://images.pexels.com/x.jpg" }))).rejects.toThrow(/not an allowed/);
    body = { "/x.jpg": HTML };
    await expect(p.fetch(c, hit({}))).rejects.toThrow(/web page code/);
    expect(readdirSync(c.attemptDir)).toEqual([]);
    body = { "/v.mp4": MP4 };
    const v = await p.fetch(c, hit({ url: "https://videos.pexels.com/v.mp4" }));
    expect(v.path.endsWith(".mp4")).toBe(true);
    body = { "/v.mp4": JPEG };
    await expect(p.fetch(c, hit({ url: "https://videos.pexels.com/v.mp4", seconds: 3 }))).rejects.toThrow(/not a video/);
    body = { "/x.jpg": Buffer.alloc(26 * 1024 * 1024, 0xff) };
    await expect(p.fetch(c, hit({}))).rejects.toThrow(/too big/);
  });
});

describe("own stock", () => {
  let db: TestDb;
  beforeAll(async () => { db = await withTestDb(); });
  afterAll(async () => { await db?.stop(); });

  it("searches_the_owners_assets_by_tag", async () => {
    const png = await sharp({ create: { width: 10, height: 20, channels: 3, background: "#fff" } }).png().toBuffer();
    const sha = (await import("node:crypto")).createHash("sha256").update(png).digest("hex");
    const rights = { attestations: [{ at: "2026-10-29T00:00:00Z", text: RIGHTS_TEXT }] };
    await registerAsset(db.pool, { kind: "image", originalName: "boat.png", mime: "image/png", bytes: png.length, width: 10, height: 20, sha256: sha, storageRef: "a/boat.png", tags: ["boat"], rights });
    const own = createStockProvider("own_stock", { ...deps(null), own: { db: db.pool, resolvePath: (r: string) => path.join(dir, r) } });
    const found = await own.search({ query: "Boat sea", kind: "image", orientation: "portrait", count: 5 });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ title: "boat.png", licence: "Own file", width: 10, height: 20 });
    expect(await own.search({ query: "boat", kind: "image", orientation: "landscape", count: 5 })).toEqual([]);
    expect(await own.search({ query: "boat", kind: "video", orientation: "portrait", count: 5 })).toEqual([]);
    const art = await own.fetch(ctx(), found[0]!);
    expect(art).toMatchObject({ sha256: sha, path: path.join(dir, "a/boat.png"), provenance: { provider: "own_stock", priceMicroUsd: 0, licence: "Own file" } });
  });
});
