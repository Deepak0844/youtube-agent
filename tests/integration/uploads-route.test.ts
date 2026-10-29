import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RIGHTS_TEXT } from "@/server/core/asset-rules";
import { registerAsset } from "@/server/db/assets";
import { login } from "@/server/db/auth";
import { assetForJob, claimIngestJob } from "@/server/db/ingest-jobs";
import { consumeSetupLink, createSetupLink } from "@/server/db/owner";
import { runChild } from "@/server/render/child";
import { createJobQueue } from "@/server/queue/job-queue";
import { handleIngestJob, recoverRunningIngest, sweepStaleUploads } from "@/worker/handlers";
import { GET as statusGet } from "@/app/api/uploads/[id]/route";
import { POST } from "@/app/api/uploads/route";
import { withTestDb, type TestDb } from "../support/db";

const BASE = "http://localhost:3000";
const RIGHTS = { text: RIGHTS_TEXT, contains_person: false, voice_clone: false };
let db: TestDb;
let root: string;
let cookie: string;
let batch: string;
const incoming = () => path.join(root, "assets-incoming");
const listIncoming = () => (existsSync(incoming()) ? readdirSync(incoming()) : []);
const runner = { root: "", runChild: (spec: Parameters<typeof runChild>[0]) => runChild(spec) };

beforeAll(async () => {
  db = await withTestDb();
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "uploads-route-")));
  runner.root = root;
  process.env.STORAGE_ROOT = root;
  delete process.env.REDIS_URL; // the route still succeeds without Redis: the worker's sweep picks the row up
  (globalThis as Record<symbol, unknown>)[Symbol.for("ytstudio.pool")] = db.pool;
});
afterAll(async () => {
  rmSync(root, { recursive: true, force: true });
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
  rmSync(incoming(), { recursive: true, force: true });
  rmSync(path.join(root, "assets"), { recursive: true, force: true });
  const link = await createSetupLink(db.pool, "create", BASE);
  await consumeSetupLink(db.pool, link.slice(link.lastIndexOf("/") + 1), { username: "owner", password: "correct-horse-battery-staple-7!" });
  const s = await login(db.pool, { username: "owner", password: "correct-horse-battery-staple-7!", ip: "198.51.100.5", userAgent: "t" });
  if (!s.ok) throw new Error("login failed");
  cookie = `ytstudio_session=${s.token}`;
  batch = crypto.randomUUID();
});

const png = () => sharp({ create: { width: 8, height: 8, channels: 3, background: "#ff0000" } }).png().toBuffer();

interface Opts {
  cookie?: string | null;
  origin?: string;
  batch?: string;
  length?: number | null;
  rights?: unknown;
  name?: string;
}
function upload(body: BodyInit, o: Opts = {}, bytes?: number) {
  const headers: Record<string, string> = { host: "localhost:3000", origin: o.origin ?? BASE, "x-rights": JSON.stringify(o.rights ?? RIGHTS) };
  const ck = o.cookie === undefined ? cookie : o.cookie;
  if (ck) headers.cookie = ck;
  const len = o.length === undefined ? bytes : o.length;
  if (len !== null && len !== undefined) headers["content-length"] = String(len);
  if (o.name) headers["x-file-name"] = encodeURIComponent(o.name);
  return POST(new Request(`${BASE}/api/uploads?batch=${o.batch ?? batch}`, { method: "POST", headers, body, duplex: "half" } as RequestInit));
}
const post = async (buf: Buffer, o: Opts = {}) => upload(new Uint8Array(buf), o, buf.length);
const status = (id: string, ck: string | null = cookie) =>
  statusGet(new Request(`${BASE}/api/uploads/${id}`, { headers: { host: "localhost:3000", ...(ck && { cookie: ck }) } }), { params: Promise.resolve({ id }) });

// A body that counts how much of it the route actually pulled.
function counting(total: number, first: Buffer) {
  const state = { pulled: 0 };
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(c) {
        const chunk = sent === 0 ? first : Buffer.alloc(1024, 1);
        sent += chunk.length;
        state.pulled += chunk.length;
        c.enqueue(chunk);
        if (sent >= total) c.close();
      },
    },
    { highWaterMark: 0 }, // pull only when somebody reads
  );
  return { stream, state };
}

describe("POST /api/uploads", () => {
  it("no_session_returns_401_before_reading_body", async () => {
    const { stream, state } = counting(10_000, Buffer.alloc(100, 1));
    const res = await upload(stream, { cookie: null }, 10_000);
    expect(res.status).toBe(401);
    expect(state.pulled).toBe(0);
  });

  it("cross_origin_rejected", async () => {
    const res = await post(await png(), { origin: "http://evil.test" });
    expect(res.status).toBe(403);
    expect((await db.pool.query("select count(*)::int n from ingest_jobs")).rows[0].n).toBe(0);
  });

  it("unknown_magic_bytes_rejected_after_4kb", async () => {
    const html = Buffer.concat([Buffer.from("<html><body>hi</body></html>"), Buffer.alloc(5000, 32)]);
    const { stream, state } = counting(4 * 1024 * 1024, html);
    const res = await upload(stream, {}, 4 * 1024 * 1024);
    expect(res.status).toBe(415);
    expect((await res.json()).message).toMatch(/web page|HTML/i);
    expect(state.pulled).toBeLessThan(1024 * 1024); // stopped near the first 4 KB, not the whole 4 MB
    expect(listIncoming()).toEqual([]);
  });

  it("oversize_rejected_by_content_length_and_by_stream", async () => {
    // by the declared length alone, before any body is read
    const { stream, state } = counting(10, Buffer.alloc(10, 1));
    expect((await upload(stream, {}, 300 * 1024 * 1024)).status).toBe(413);
    expect(state.pulled).toBe(0);
    // an image larger than the image limit: refused right after the sniff
    await db.pool.query("update settings set value = '10000' where key = 'assets.max_image_bytes'").catch(() => undefined);
    await db.pool.query(`insert into settings (key, value, updated_by) values ('assets.max_image_bytes', '10000', 'test') on conflict (key) do update set value = excluded.value`);
    const big = Buffer.concat([await png(), Buffer.alloc(20_000)]);
    expect((await post(big)).status).toBe(413);
    // a body longer than it declared is cut off while streaming
    expect((await upload(big, {}, 9_000)).status).toBe(413);
    expect(listIncoming()).toEqual([]);
  });

  it("audio_has_its_own_per_file_limit", async () => {
    await db.pool.query(`insert into settings (key, value, updated_by) values ('assets.max_audio_bytes', '6000', 'test') on conflict (key) do update set value = excluded.value`);
    const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVEfmt "), Buffer.alloc(8000)]);
    expect((await post(wav)).status).toBe(413);
  });

  it("101st_file_in_batch_rejected", async () => {
    await db.pool.query(
      `insert into ingest_jobs (id, batch_id, status, original_name, contains_person, voice_clone, rights, created_at)
       select gen_random_uuid(), $1, 'rejected', 'x', false, false, '{"attestations":[]}', now() - interval '1 day' from generate_series(1, 100)`,
      [batch],
    );
    const res = await post(await png());
    expect(res.status).toBe(409);
    expect((await post(await png(), { batch: crypto.randomUUID() })).status).toBe(201); // another batch is fine
  });

  it("rate_limit_returns_429", async () => {
    await db.pool.query(
      `insert into ingest_jobs (id, batch_id, status, original_name, contains_person, voice_clone, rights)
       select gen_random_uuid(), gen_random_uuid(), 'rejected', 'x', false, false, '{"attestations":[]}' from generate_series(1, 60)`,
    );
    expect((await post(await png())).status).toBe(429);
  });

  it("a_full_store_names_what_holds_the_space", async () => {
    await db.pool.query(`insert into settings (key, value, updated_by) values ('assets.total_bytes_cap', '950', 'test') on conflict (key) do update set value = excluded.value`);
    await registerAsset(db.pool, {
      kind: "image", originalName: "k.png", mime: "image/png", bytes: 900, sha256: "a".repeat(64), storageRef: "assets/x/main.png", keep: true,
      rights: { attestations: [{ at: new Date().toISOString(), text: RIGHTS_TEXT }] },
    });
    const res = await post(await png());
    expect(res.status).toBe(507);
    expect((await res.json()).message).toContain("files marked Keep");
  });

  it("rights_must_be_explicit_and_the_server_stamps_the_time", async () => {
    expect((await post(await png(), { rights: { ...RIGHTS, at: "1999-01-01T00:00:00Z" } })).status).toBe(400);
    expect((await post(await png(), { rights: { text: RIGHTS_TEXT, voice_clone: false } })).status).toBe(400); // contains_person not answered
    const person = await post(await png(), { rights: { ...RIGHTS, contains_person: true } });
    expect(person.status).toBe(422);
    expect((await person.json()).message).toMatch(/consent/);
    const before = Date.now();
    const ok = await post(await png(), { rights: { ...RIGHTS, contains_person: true, consent_likeness: true } });
    expect(ok.status).toBe(201);
    const { rows } = await db.pool.query("select rights from ingest_jobs where id = $1", [(await ok.json()).id]);
    const at = Date.parse(rows[0].rights.attestations[0].at);
    expect(at).toBeGreaterThanOrEqual(before - 1000);
    expect(at).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("content_length_is_required", async () => {
    expect((await upload(await png(), {}, undefined)).status).toBe(411);
  });

  it("ingest_job_survives_worker_restart_and_is_not_run_twice", async () => {
    const res = await post(await png());
    expect(res.status).toBe(201);
    const { id, status: st } = await res.json();
    expect(st).toBe("queued");
    expect(listIncoming()).toEqual([id]); // moved to assets-incoming/<id>
    // the same job delivered twice at once: one claim wins, one asset
    const runs = await Promise.all([handleIngestJob(db.pool, runner, id), handleIngestJob(db.pool, runner, id)]);
    expect(runs.filter((r) => r.ran)).toHaveLength(1);
    expect((await db.pool.query("select count(*)::int n from assets")).rows[0].n).toBe(1);
    expect(await (await status(id)).json()).toMatchObject({ status: "done" });
    expect((await handleIngestJob(db.pool, runner, id)).ran).toBe(false); // a replay after it finished does nothing
    expect((await db.pool.query("select count(*)::int n from audit_log where event = 'asset.added'")).rows[0].n).toBe(1);

    // a worker that died after claiming: the next start puts the row back and the file is still there
    const second = await (await post(await sharp({ create: { width: 9, height: 9, channels: 3, background: "#00ff00" } }).png().toBuffer())).json();
    expect(await claimIngestJob(db.pool, second.id)).not.toBeNull(); // worker 1 claimed, then died
    expect((await handleIngestJob(db.pool, runner, second.id)).ran).toBe(false); // nothing else may run it meanwhile
    await recoverRunningIngest(db.pool, root);
    expect((await handleIngestJob(db.pool, runner, second.id)).ran).toBe(true);
    expect((await status(second.id).then((r) => r.json())).status).toBe("done");
    expect((await db.pool.query("select count(*)::int n from assets")).rows[0].n).toBe(2);
  });

  it("a_crash_after_the_asset_was_registered_finishes_done_with_files_intact", async () => {
    const { id } = await (await post(await png())).json();
    expect(await claimIngestJob(db.pool, id)).not.toBeNull();
    // the dead worker had ingested (source deleted) and registered the asset, but never marked the job done
    rmSync(path.join(incoming(), id));
    mkdirSync(path.join(root, "assets", id), { recursive: true });
    writeFileSync(path.join(root, "assets", id, "main.png"), "x");
    await registerAsset(db.pool, {
      kind: "image", originalName: "a.png", mime: "image/png", bytes: 1, sha256: "b".repeat(64), storageRef: `assets/${id}/main.png`,
      rights: { attestations: [{ at: new Date().toISOString(), text: RIGHTS_TEXT }] },
    });
    await recoverRunningIngest(db.pool, root);
    expect(await (await status(id)).json()).toMatchObject({ status: "done" });
    expect(existsSync(path.join(root, "assets", id, "main.png"))).toBe(true);
    // even if the row went back to the queue, a rerun redoes nothing and keeps the files
    await db.pool.query("update ingest_jobs set status = 'queued' where id = $1", [id]);
    expect((await handleIngestJob(db.pool, runner, id)).ran).toBe(true);
    expect(existsSync(path.join(root, "assets", id, "main.png"))).toBe(true);
    expect((await db.pool.query("select count(*)::int n from assets")).rows[0].n).toBe(1);
    expect(await assetForJob(db.pool, id)).not.toBeNull();
  });

  it("a_job_that_keeps_failing_for_other_reasons_ends_after_three_tries", async () => {
    const { id } = await (await post(await png())).json();
    writeFileSync(path.join(root, "assets"), "not a folder"); // every try fails to make its output folder (not the file's fault)
    for (const want of ["queued", "queued", "rejected"]) {
      expect((await handleIngestJob(db.pool, runner, id)).ran).toBe(true);
      expect((await (await status(id)).json()).status).toBe(want);
    }
    expect((await handleIngestJob(db.pool, runner, id)).ran).toBe(false); // not requeued again
    const j = await (await status(id)).json();
    expect(j.reason).toBe("Could not be processed after several tries. Upload it again.");
    expect(listIncoming()).toEqual([]);
    rmSync(path.join(root, "assets"), { force: true });
  });

  it("a_running_job_whose_file_is_gone_asks_for_a_new_upload", async () => {
    const { id } = await (await post(await png())).json();
    await claimIngestJob(db.pool, id);
    rmSync(path.join(incoming(), id));
    await recoverRunningIngest(db.pool, root);
    const j = await (await status(id)).json();
    expect(j).toMatchObject({ status: "rejected" });
    expect(j.reason).toContain("Upload it again");
  });

  it("uploads_that_never_finished_arriving_are_ended_and_cleaned", async () => {
    const id = crypto.randomUUID();
    await db.pool.query(
      `insert into ingest_jobs (id, batch_id, status, original_name, contains_person, voice_clone, rights, created_at)
       values ($1, $2, 'receiving', 'x', false, false, '{"attestations":[]}', now() - interval '2 hours')`,
      [id, batch],
    );
    mkdirSync(incoming(), { recursive: true });
    writeFileSync(path.join(incoming(), `${id}.part`), "partial");
    await sweepStaleUploads(db.pool, root);
    expect(listIncoming()).toEqual([]);
    expect(await (await status(id)).json()).toMatchObject({ status: "rejected", reason: "The upload was interrupted. Try again." });
  });

  it("the_ingest_queue_delivers_a_duplicate_job_once", async () => {
    const q = createJobQueue(db.redisUrl, "ingest", "t17");
    const seen: string[] = [];
    const id = crypto.randomUUID();
    await q.enqueueIngest(id);
    await q.enqueueIngest(id);
    const w = q.startWorker(async (j) => void seen.push(j));
    await new Promise((r) => setTimeout(r, 1000));
    await w.close();
    await q.close();
    expect(seen).toEqual([id]);
  });

  it("rejected_file_removed_from_incoming", async () => {
    const broken = Buffer.concat([(await png()).subarray(0, 40), Buffer.alloc(200, 7)]); // PNG magic, damaged body
    const res = await post(broken);
    expect(res.status).toBe(201);
    const { id } = await res.json();
    expect(listIncoming()).toEqual([id]);
    expect((await handleIngestJob(db.pool, runner, id)).ran).toBe(true);
    expect(listIncoming()).toEqual([]);
    expect(existsSync(path.join(root, "assets", id))).toBe(false);
    const j = await (await status(id)).json();
    expect(j).toMatchObject({ status: "rejected" });
    expect(j.reason).toMatch(/could not be read/);
    expect((await db.pool.query("select count(*)::int n from assets")).rows[0].n).toBe(0);
  });

  it("file_name_with_html_is_escaped_in_response_and_never_a_path", async () => {
    const res = await post(await png(), { name: "<img src=x onerror=alert(1)>\u202egnp.png" });
    expect(res.status).toBe(201);
    const { id } = await res.json();
    const j = await (await status(id)).json();
    expect(j.name).not.toMatch(/[<>"]/);
    expect(j.name).toContain("&lt;");
    expect(JSON.stringify(j)).not.toContain("‮");
    expect(readdirSync(root).sort()).toEqual(["assets-incoming"]); // nothing outside the fixed folder
    expect(listIncoming()).toEqual([id]);
  });
});

describe("GET /api/uploads/<id>", () => {
  it("status_endpoint_needs_session", async () => {
    const { id } = await (await post(await png())).json();
    expect((await status(id, null)).status).toBe(401);
    expect((await status(id)).status).toBe(200);
    expect((await status(crypto.randomUUID())).status).toBe(404);
    expect((await status("not-a-uuid")).status).toBe(404);
  });
});
