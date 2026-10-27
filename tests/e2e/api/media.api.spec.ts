import { createHmac } from "node:crypto";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { expect, test, type APIResponse } from "@playwright/test";
import { uuidv7 } from "@/server/core/ids";
import { makeKeyring } from "@/server/core/vault-crypto";
import { getOrCreateMediaKey } from "@/server/db/media-key";
import { signMediaUrl } from "@/server/storage/sign";
import { endSessionPool, mintSession } from "../fixtures/sessions";

// Real production build, real Postgres vault, real files under STORAGE_ROOT. The signature is the only credential.
const ROOT = process.env.E2E_STORAGE_ROOT!;
const VID = uuidv7();
const OTHER = uuidv7();
const SIZE = 1000;
const BYTES = Buffer.from(Array.from({ length: SIZE }, (_, i) => i % 251));
const nowSec = () => Math.floor(Date.now() / 1000);

let pool: pg.Pool;
let key: Buffer;
const seen: string[] = []; // every response head+body, searched for the key at the end

async function rec(res: APIResponse): Promise<APIResponse> {
  const body = await res.body();
  seen.push(JSON.stringify(res.headers()), body.toString("latin1"));
  return res;
}
const url = (rel: string, exp = nowSec() + 600) => signMediaUrl(rel, exp, key);
const rawSig = (rel: string, exp: number) => createHmac("sha256", key).update(`GET\n${rel}\n${exp}`).digest("base64url");

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 2 });
  key = await getOrCreateMediaKey(pool, makeKeyring(process.env.E2E_VAULT_MASTER_KEY!));
  mkdirSync(path.join(ROOT, "videos", VID), { recursive: true });
  mkdirSync(path.join(ROOT, "videos", OTHER), { recursive: true });
  writeFileSync(path.join(ROOT, "videos", VID, "final.mp4"), BYTES);
  writeFileSync(path.join(ROOT, "videos", VID, "sibling.mp4"), BYTES);
  writeFileSync(path.join(ROOT, "videos", VID, "empty.mp4"), "");
  writeFileSync(path.join(ROOT, "videos", VID, "thumb.png"), BYTES);
  writeFileSync(path.join(ROOT, "videos", VID, "meta.json"), '{"a":1}');
  writeFileSync(path.join(ROOT, "videos", VID, "page.html"), "<script>alert(1)</script>");
  writeFileSync(path.join(ROOT, "videos", VID, "logo.svg"), "<svg onload=alert(1)/>");
  writeFileSync(path.join(ROOT, "videos", VID, "noext"), "x");
  writeFileSync(path.join(ROOT, "top-secret.mp4"), "TOP SECRET");
  const outside = path.join(path.dirname(ROOT), `${path.basename(ROOT)}-outside`);
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(outside, "leak.mp4"), "LEAKED");
  symlinkSync(path.join(outside, "leak.mp4"), path.join(ROOT, "videos", VID, "link.mp4"));
  symlinkSync(outside, path.join(ROOT, "videos", VID, "linkdir"));
  mkdirSync(path.join(ROOT, "videos", VID, "adir.mp4"));
  writeFileSync(path.join(ROOT, "videos", OTHER, "final.mp4"), BYTES);
});
test.afterAll(async () => {
  await pool.end();
  await endSessionPool();
});

test("valid_signature_serves_the_file", async ({ request }) => {
  const res = await rec(await request.get(url(`videos/${VID}/final.mp4`)));
  expect(res.status()).toBe(200);
  expect(Buffer.compare(await res.body(), BYTES)).toBe(0);
  const h = res.headers();
  expect(h["content-type"]).toBe("video/mp4");
  expect(h["x-content-type-options"]).toBe("nosniff");
  expect(h["cache-control"]).toBe("private, no-store");
  expect(h["accept-ranges"]).toBe("bytes");
  expect(h["content-disposition"]).toBeUndefined();
  expect(h["set-cookie"]).toBeUndefined();
});

test("head_has_headers_and_no_body", async ({ request }) => {
  const res = await rec(await request.head(url(`videos/${VID}/final.mp4`)));
  expect(res.status()).toBe(200);
  expect(res.headers()["content-length"]).toBe(String(SIZE));
  expect((await res.body()).length).toBe(0);
});

test("a_session_cookie_neither_helps_nor_is_needed", async ({ request }) => {
  const token = await mintSession();
  const withCookie = await rec(await request.get(`/api/media/videos/${VID}/final.mp4`, { headers: { cookie: `ytstudio_session=${token}` } }));
  expect(withCookie.status()).toBe(403);
  const signed = await rec(await request.get(url(`videos/${VID}/final.mp4`), { headers: { cookie: "ytstudio_session=garbage" } }));
  expect(signed.status()).toBe(200);
});

test("tampered_path_exp_or_sig_is_403", async ({ request }) => {
  const exp = nowSec() + 600;
  const good = signMediaUrl(`videos/${VID}/final.mp4`, exp, key);
  const sig = new URL(good, "http://x").searchParams.get("s")!;
  const bad = [
    `/api/media/videos/${VID}/final.mp4?e=${exp + 1}&s=${sig}`,
    `/api/media/videos/${VID}/final.mp4?e=${exp}&s=${(sig[0] === "A" ? "B" : "A") + sig.slice(1)}`,
    `/api/media/videos/${OTHER}/final.mp4?e=${exp}&s=${sig}`,
    `/api/media/videos/${VID}/final.mp4?e=${exp}`,
    `/api/media/videos/${VID}/final.mp4?s=${sig}`,
    `/api/media/videos/${VID}/final.mp4?e=${exp}&s=${sig}&s=${sig}x`,
    `/api/media/videos/${VID}/final.mp4?e=abc&s=${sig}`,
    `/api/media/videos/${VID}/final.mp4?e=${exp}&s=`,
  ];
  for (const u of bad) {
    const res = await rec(await request.get(u));
    expect(res.status(), u).toBe(403);
  }
});

test("expired_url_is_403_after_its_second_passes", async ({ request }) => {
  const rel = `videos/${VID}/final.mp4`;
  const exp = nowSec() + 3;
  const u = signMediaUrl(rel, exp, key);
  expect((await rec(await request.get(u))).status()).toBe(200);
  expect((await rec(await request.get(signMediaUrl(rel, nowSec() - 1, key)))).status()).toBe(403);
  while (nowSec() < exp) await new Promise((r) => setTimeout(r, 100));
  expect((await rec(await request.get(u))).status()).toBe(403); // at the boundary second and after
});

test("signature_for_one_path_does_not_work_for_a_sibling_path", async ({ request }) => {
  const exp = nowSec() + 600;
  const sig = rawSig(`videos/${VID}/final.mp4`, exp);
  const res = await rec(await request.get(`/api/media/videos/${VID}/sibling.mp4?e=${exp}&s=${sig}`));
  expect(res.status()).toBe(403);
});

test("no_signature_and_no_session_is_403_with_no_file_info", async ({ request }) => {
  const exp = nowSec() + 600;
  const probes = [
    `/api/media/videos/${VID}/final.mp4`, // exists
    `/api/media/videos/${VID}/does-not-exist.mp4`, // does not
    `/api/media/nope`,
    `/api/media/videos/${VID}/final.mp4?e=${exp}&s=${"A".repeat(43)}`,
    `/api/media/videos/${VID}/does-not-exist.mp4?e=${exp}&s=${"A".repeat(43)}`,
  ];
  const results = [];
  for (const p of probes) {
    const res = await rec(await request.get(p));
    expect(res.status(), p).toBe(403);
    results.push({ body: (await res.body()).toString(), type: res.headers()["content-type"], len: res.headers()["content-length"] });
  }
  for (const r of results) expect(r).toEqual(results[0]);
  expect(results[0]!.body).not.toMatch(/final|exists|found|VID/i);
});

test("traversal_nul_and_symlink_escape_are_refused", async ({ request }) => {
  const exp = nowSec() + 600;
  // Correctly signed (by hand) but not a path we serve: the route must normalise before it trusts the MAC.
  const hostile = [`videos/${VID}/../../top-secret.mp4`, `videos/../top-secret.mp4`, `videos/${VID}//final.mp4`, `/videos/${VID}/final.mp4`, `videos/${VID}/final.mp4\0`];
  for (const rel of hostile) {
    const enc = rel.split("/").map(encodeURIComponent).join("/");
    const res = await rec(await request.get(`/api/media/${enc}?e=${exp}&s=${rawSig(rel, exp)}`));
    expect([403, 404], rel).toContain(res.status());
    expect((await res.body()).toString()).not.toContain("TOP SECRET");
  }
  // Raw traversal in the URL (the client keeps %2e%2e and %2F as written).
  for (const raw of [`/api/media/videos/${VID}/%2e%2e/%2e%2e/top-secret.mp4`, `/api/media/videos%2F${VID}%2F..%2F..%2Ftop-secret.mp4`]) {
    const res = await rec(await request.get(`${raw}?e=${exp}&s=${rawSig("videos/" + VID + "/../../top-secret.mp4", exp)}`));
    expect([403, 404], raw).toContain(res.status());
    expect((await res.body()).toString()).not.toContain("TOP SECRET");
  }
  // A validly signed URL whose file is a symlink to outside the root, or sits below a symlinked folder, or is a folder.
  for (const rel of [`videos/${VID}/link.mp4`, `videos/${VID}/linkdir/leak.mp4`, `videos/${VID}/adir.mp4`]) {
    const res = await rec(await request.get(url(rel)));
    expect(res.status(), rel).toBe(404);
    expect((await res.body()).toString()).not.toContain("LEAKED");
  }
  // Outside the folders the app ever serves from, even with a valid signature.
  expect((await rec(await request.get(url("top-secret.mp4")))).status()).toBe(404);
});

test("only_allow_listed_types_are_served_and_non_media_is_an_attachment", async ({ request }) => {
  const meta = await rec(await request.get(url(`videos/${VID}/meta.json`)));
  expect(meta.status()).toBe(200);
  expect(meta.headers()["content-type"]).toContain("application/json");
  expect(meta.headers()["content-disposition"]).toMatch(/^attachment/);
  const png = await rec(await request.get(url(`videos/${VID}/thumb.png`)));
  expect(png.headers()["content-type"]).toBe("image/png");
  expect(png.headers()["content-disposition"]).toBeUndefined();
  for (const f of ["page.html", "logo.svg", "noext"]) {
    const res = await rec(await request.get(url(`videos/${VID}/${f}`)));
    expect(res.status(), f).toBe(404);
  }
});

test("range_request_206_and_bad_range_416", async ({ request }) => {
  const rel = `videos/${VID}/final.mp4`;
  const get = async (range: string) => rec(await request.get(url(rel), { headers: { range } }));
  const r1 = await get("bytes=10-19");
  expect(r1.status()).toBe(206);
  expect(r1.headers()["content-range"]).toBe(`bytes 10-19/${SIZE}`);
  expect(r1.headers()["content-length"]).toBe("10");
  expect(Buffer.compare(await r1.body(), BYTES.subarray(10, 20))).toBe(0);

  const open = await get("bytes=990-");
  expect(open.status()).toBe(206);
  expect(open.headers()["content-range"]).toBe(`bytes 990-999/${SIZE}`);
  const suffix = await get("bytes=-5");
  expect(suffix.status()).toBe(206);
  expect(Buffer.compare(await suffix.body(), BYTES.subarray(SIZE - 5))).toBe(0);
  const clamp = await get("bytes=995-5000");
  expect(clamp.status()).toBe(206);
  expect(clamp.headers()["content-range"]).toBe(`bytes 995-999/${SIZE}`);
  const whole = await get("bytes=0-");
  expect(whole.status()).toBe(206);
  expect((await whole.body()).length).toBe(SIZE);

  for (const bad of ["bytes=2000-3000", `bytes=${SIZE}-`, "bytes=20-10", "bytes=abc", "bytes=-0", "bytes=0-1,5-6", "items=0-1", "bytes=", "bytes=-", "bytes=1-2-3", "bytes=0x1-5", "bytes=99999999999999999999-"]) {
    const res = await get(bad);
    expect(res.status(), bad).toBe(416);
    expect(res.headers()["content-range"], bad).toBe(`bytes */${SIZE}`);
  }
  const empty = await rec(await request.get(url(`videos/${VID}/empty.mp4`), { headers: { range: "bytes=0-" } }));
  expect(empty.status()).toBe(416);
  const emptyPlain = await rec(await request.get(url(`videos/${VID}/empty.mp4`)));
  expect(emptyPlain.status()).toBe(200);
});

test("wrong_host_and_wrong_method_are_refused", async ({ request }) => {
  const res = await rec(await request.get(url(`videos/${VID}/final.mp4`), { headers: { host: "evil.test" } }));
  expect(res.status()).toBe(403);
  for (const method of ["post", "put", "delete", "patch"] as const) {
    const r = await rec(await request[method](url(`videos/${VID}/final.mp4`), { data: "x" }));
    expect(r.status(), method).toBe(405);
  }
});

test("signing_key_never_appears_in_responses_logs_or_audit", async () => {
  const needles = [key.toString("base64"), key.toString("base64url"), key.toString("hex")];
  const haystacks = [seen.join("\n"), readFileSync(process.env.E2E_SERVER_LOG!, "utf8")];
  const audit = await pool.query("select * from audit_log");
  haystacks.push(JSON.stringify(audit.rows));
  const secrets = await pool.query("select name, hint from secrets");
  haystacks.push(JSON.stringify(secrets.rows));
  for (const h of haystacks) for (const n of needles) expect(h.includes(n)).toBe(false);
  expect(seen.length).toBeGreaterThan(20); // the scan really looked at traffic
  // Query strings (they carry the signature) are not written to the server log either.
  expect(haystacks[1]).not.toMatch(/[?&]s=[A-Za-z0-9_-]{43}/);
});
