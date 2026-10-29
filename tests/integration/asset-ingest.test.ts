import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RIGHTS_TEXT } from "@/server/core/asset-rules";
import { AssetRefused, registerAsset, type RegisterInput } from "@/server/db/assets";
import { runChild, type ChildSpec } from "@/server/render/child";
import { ingestAudio, ingestImage, type IngestResult } from "@/server/render/ingest";
import { withTestDb, type TestDb } from "../support/db";
import { assertFfprobeAvailable } from "../support/tools";

const FX = path.join(process.cwd(), "tests/fixtures/assets");
let root: string;
let db: TestDb;
let calls: ChildSpec[];
const deps = { runChild: (spec: ChildSpec) => (calls.push(spec), runChild(spec)) };
let n = 0;

// Every test works on a private copy of the fixture, because ingest deletes the source when it rejects.
function stage(fixture: string, asName = fixture): { src: string; dest: string } {
  const dir = path.join(root, `case-${++n}`);
  const dest = path.join(dir, "out");
  const src = path.join(dir, "in", asName);
  execFileSync("mkdir", ["-p", path.dirname(src), dest]);
  copyFileSync(path.join(FX, fixture), src);
  return { src, dest };
}
const okOf = (r: IngestResult) => {
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}: ${r.message}`);
  return r;
};
const probe = (f: string) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", f]).toString());

beforeAll(async () => {
  assertFfprobeAvailable();
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "ingest-")));
  db = await withTestDb();
});
afterAll(async () => {
  rmSync(root, { recursive: true, force: true });
  await db?.stop();
});
beforeEach(async () => {
  calls = [];
  await db.reset();
});
afterEach(() => undefined);

describe("ingestImage", () => {
  it("exif_orientation_applied_before_metadata_strip_and_gps_gone", async () => {
    const { src, dest } = stage("portrait-exif-gps.jpg");
    const before = (await sharp(src).metadata()).exif!; // the fixture really carries camera name and GPS (77/1 longitude, either byte order)
    expect(before.includes("SecretCam")).toBe(true);
    expect(before.includes(Buffer.from([77, 0, 0, 0, 1, 0, 0, 0])) || before.includes(Buffer.from([0, 0, 0, 77, 0, 0, 0, 1]))).toBe(true);
    const r = okOf(await ingestImage(deps, { srcPath: src, destDir: dest }));
    expect(r).toMatchObject({ mime: "image/jpeg", width: 40, height: 60 }); // stored 60x40, orientation 6 turns it upright
    for (const f of Object.values(r.files)) {
      const buf = readFileSync(f);
      expect(buf.includes("GPS"), f).toBe(false);
      expect(buf.includes("SecretCam"), f).toBe(false);
      expect(buf.includes("Exif"), f).toBe(false);
      const m = await sharp(f).metadata();
      expect(m.exif, f).toBeUndefined();
      expect(m.orientation, f).toBeUndefined();
    }
    const { data } = await sharp(r.files.main!).raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(200); // top-left is red: the left half moved to the top
    expect(data[2]).toBeLessThan(80);
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(src)).toBe(false);
  });

  it("writes preview, thumb and both crops", async () => {
    const { src, dest } = stage("portrait-exif-gps.jpg");
    const r = okOf(await ingestImage(deps, { srcPath: src, destDir: dest }));
    expect(Object.keys(r.files).sort()).toEqual(["crop_169", "crop_916", "main", "preview", "thumb"]);
    for (const k of ["preview", "thumb", "crop_169", "crop_916"]) expect((await sharp(r.files[k]!).metadata()).format, k).toBe("webp");
    const c916 = await sharp(r.files.crop_916!).metadata();
    const c169 = await sharp(r.files.crop_169!).metadata();
    expect(c916.width! / c916.height!).toBeCloseTo(9 / 16, 1);
    expect(c169.width! / c169.height!).toBeCloseTo(16 / 9, 1);
    expect(Math.max((await sharp(r.files.thumb!).metadata()).width!, (await sharp(r.files.thumb!).metadata()).height!)).toBeLessThanOrEqual(320);
  });

  it("extension_png_but_bytes_jpeg_is_stored_as_jpeg", async () => {
    const { src, dest } = stage("portrait-exif-gps.jpg", "holiday.png");
    const r = okOf(await ingestImage(deps, { srcPath: src, destDir: dest }));
    expect(r.mime).toBe("image/jpeg");
    expect(r.files.main).toMatch(/\.jpg$/);
    expect((await sharp(r.files.main!).metadata()).format).toBe("jpeg");
  });

  it("keeps real transparency as png and turns opaque pngs into jpeg", async () => {
    const a = okOf(await ingestImage(deps, stage2("alpha.png")));
    expect(a.mime).toBe("image/png");
    const p = okOf(await ingestImage(deps, stage2("plain.png")));
    expect(p.mime).toBe("image/jpeg");
    const w = okOf(await ingestImage(deps, stage2("plain.webp")));
    expect(w.mime).toBe("image/jpeg");
  });

  it("html_polyglot_and_svg_rejected", async () => {
    for (const [fx, reason] of [["polyglot.gif", "html"], ["vector.svg", "svg"]] as const) {
      const { src, dest } = stage(fx);
      const r = await ingestImage(deps, { srcPath: src, destDir: dest });
      expect(r, fx).toMatchObject({ ok: false, reason });
      expect(existsSync(src), fx).toBe(false);
      expect(readdirSync(dest), fx).toEqual([]);
    }
    expect(calls).toHaveLength(0); // refused on the bytes alone, no decoder started
  });

  it("heic_rejected_with_convert_message", async () => {
    const { src, dest } = stage("photo.heic");
    const r = await ingestImage(deps, { srcPath: src, destDir: dest });
    expect(r).toMatchObject({ ok: false, reason: "heic" });
    expect(!r.ok && r.message).toMatch(/Convert.*JPEG or PNG/);
    expect(existsSync(src)).toBe(false);
  });

  it("60_megapixel_rejected_in_worker_and_source_deleted", async () => {
    const { src, dest } = stage("huge-60mp.png");
    const r = await ingestImage(deps, { srcPath: src, destDir: dest });
    expect(r).toMatchObject({ ok: false, reason: "too_many_pixels" });
    expect(existsSync(src)).toBe(false);
    expect(readdirSync(dest)).toEqual([]);
    expect(calls).toHaveLength(1); // the decision was made inside the child process, not in the web process
    expect(calls[0]!.command).toBe(process.execPath);
  });

  it("truncated_jpeg_rejected_not_half_stored", async () => {
    const { src, dest } = stage("truncated.jpg");
    const r = await ingestImage(deps, { srcPath: src, destDir: dest });
    expect(r).toMatchObject({ ok: false, reason: "decode_failed" });
    expect(existsSync(src)).toBe(false);
    expect(readdirSync(dest)).toEqual([]);
  });

  it("gif_becomes_first_frame_only", async () => {
    const { src, dest } = stage("animated.gif");
    const r = okOf(await ingestImage(deps, { srcPath: src, destDir: dest }));
    expect(r.mime).toBe("image/jpeg");
    const m = await sharp(r.files.main!).metadata();
    expect(m.pages ?? 1).toBe(1);
    expect(m.height).toBe(32);
    const { data } = await sharp(r.files.main!).raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(200); // first frame is red
    expect(data[1]).toBeLessThan(80);
  });

  it("an empty file is rejected", async () => {
    const { src, dest } = stage("plain.png");
    execFileSync("truncate", ["-s", "0", src]);
    expect(await ingestImage(deps, { srcPath: src, destDir: dest })).toMatchObject({ ok: false });
    expect(existsSync(src)).toBe(false);
  });
});

function stage2(fx: string) {
  const { src, dest } = stage(fx);
  return { srcPath: src, destDir: dest };
}

describe("ingestAudio", () => {
  it.each(["tone.wav", "tone.mp3", "tone.m4a", "tone.flac"])("%s becomes a metadata-free lossless copy plus a 128k mp3 preview", async (fx) => {
    const { src, dest } = stage(fx);
    const r = okOf(await ingestAudio(deps, { srcPath: src, destDir: dest }));
    expect(r.kind).toBe("audio");
    expect(r.durationS).toBeCloseTo(1, 0);
    const main = probe(r.files.main!);
    expect(main.streams).toHaveLength(1);
    expect(main.streams[0].codec_name).toBe("flac");
    expect(Number(main.streams[0].sample_rate)).toBe(fx === "tone.wav" ? 22050 : 44100); // sample rate preserved
    expect(Object.keys(main.format.tags ?? {})).toEqual([]);
    const prev = probe(r.files.preview!);
    expect(prev.streams[0].codec_name).toBe("mp3");
    expect(Number(prev.format.bit_rate)).toBeGreaterThan(120_000);
    expect(Number(prev.format.bit_rate)).toBeLessThan(140_000);
    expect(readFileSync(r.files.preview!).includes("Secret title")).toBe(false);
    expect(existsSync(src)).toBe(false);
  });

  it("audio_without_stream_rejected", async () => {
    for (const [fx, reason] of [["video-only.m4a", "no_audio"], ["bad.wav", "probe_failed"]] as const) {
      const { src, dest } = stage(fx);
      const r = await ingestAudio(deps, { srcPath: src, destDir: dest });
      expect(r, fx).toMatchObject({ ok: false, reason });
      expect(existsSync(src), fx).toBe(false);
      expect(readdirSync(dest), fx).toEqual([]);
    }
  });

  it("audio longer than 60 minutes is rejected", async () => {
    const { src, dest } = stage("tone.wav");
    const r = await ingestAudio(deps, { srcPath: src, destDir: dest, maxSeconds: 0.5 });
    expect(r).toMatchObject({ ok: false, reason: "too_long" });
  });

  it("an image sent to the audio door is refused", async () => {
    const { src, dest } = stage("plain.png");
    expect(await ingestAudio(deps, { srcPath: src, destDir: dest })).toMatchObject({ ok: false, reason: "unknown" });
  });
});

const att = (at: string, extra: object = {}) => ({ at, text: RIGHTS_TEXT, ...extra });
const sha = (c: string) => c.repeat(64);
const base = (over: Partial<RegisterInput> = {}): RegisterInput => ({
  kind: "image", originalName: "a.jpg", mime: "image/jpeg", bytes: 100, width: 10, height: 10, sha256: sha("a"), storageRef: "assets/x/main.jpg",
  tags: [], rights: { attestations: [att("2026-10-29T10:00:00Z")] }, ...over,
});

describe("registerAsset", () => {
  it("same_bytes_twice_merges_union_tags_all_rights_keep_wins", async () => {
    const first = await registerAsset(db.pool, base({ tags: ["a", "b"], keep: false }));
    expect(first.duplicate).toBe(false);
    await db.pool.query("update assets set deleted_at = now(), purge_at = now() + interval '7 days' where id = $1", [first.asset.id]);
    const second = await registerAsset(db.pool, base({ tags: ["b", "c"], keep: true, storageRef: "assets/y/main.jpg", rights: { attestations: [att("2026-10-30T10:00:00Z", { consent_likeness: true })] } }));
    expect(second.duplicate).toBe(true);
    expect(second.asset.id).toBe(first.asset.id);
    expect(second.asset.storageRef).toBe("assets/x/main.jpg"); // the existing files stay
    expect(second.asset.keep).toBe(true);
    expect([...second.asset.tags].sort()).toEqual(["a", "b", "c"]);
    expect(second.asset.rights.attestations).toHaveLength(2);
    expect(second.asset.rights.attestations[1]).toMatchObject({ consent_likeness: true });
    expect(second.asset.deletedAt).toBeNull();
    expect(second.asset.purgeAt).toBeNull();
    const third = await registerAsset(db.pool, base({ keep: false }));
    expect(third.asset.keep).toBe(true); // Keep never goes back
    expect(third.asset.rights.attestations).toHaveLength(3);
    expect((await db.pool.query("select count(*)::int as n from assets")).rows[0].n).toBe(1);
  });

  it("racing_duplicate_uploads_make_one_row", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => registerAsset(db.pool, base({ tags: [`t${i}`], rights: { attestations: [att(`2026-10-29T10:00:0${i}Z`)] } }))),
    );
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    const { rows } = await db.pool.query("select tags, jsonb_array_length(rights->'attestations') as n from assets");
    expect(rows).toHaveLength(1);
    expect(rows[0].n).toBe(8);
    expect(rows[0].tags).toHaveLength(8);
  });

  it("filename_with_dotdot_or_nul_is_metadata_only_never_a_path", async () => {
    const { asset } = await registerAsset(db.pool, base({ originalName: "../../etc/passwd\u0000.png" }));
    expect(asset.originalName).toBe("passwd.png");
    expect(asset.storageRef).toBe("assets/x/main.jpg");
    const { src, dest } = stage("plain.png", "..%2F..%2Fx.png");
    const r = okOf(await ingestImage(deps, { srcPath: src, destDir: dest }));
    for (const f of Object.values(r.files)) expect(path.dirname(f)).toBe(dest); // outputs are fixed names inside destDir
  });

  it("no_rights_attestation_refused", async () => {
    await expect(registerAsset(db.pool, base({ rights: { attestations: [] } }))).rejects.toMatchObject({ reason: "no_attestation" });
    await expect(registerAsset(db.pool, base({ rights: { attestations: [{ at: "2026-10-29T10:00:00Z", text: "yes" as never }] } }))).rejects.toBeInstanceOf(AssetRefused);
    expect((await db.pool.query("select count(*)::int as n from assets")).rows[0].n).toBe(0);
  });

  it("voice_reference_without_consent_refused", async () => {
    const audio = { kind: "audio" as const, mime: "audio/flac", width: null, height: null, durationS: 5, voiceCloneReference: true };
    await expect(registerAsset(db.pool, base(audio))).rejects.toMatchObject({ reason: "voice_consent_missing" });
    const ok = await registerAsset(db.pool, base({ ...audio, rights: { attestations: [att("2026-10-29T10:00:00Z", { consent_voice: true })] } }));
    expect(ok.asset.durationS).toBe(5);
  });

  it("a photo tagged as a person without consent is refused", async () => {
    await expect(registerAsset(db.pool, base({ tags: ["person"] }))).rejects.toMatchObject({ reason: "likeness_consent_missing" });
  });

  it("the database itself refuses a row with no attestation", async () => {
    await expect(
      db.pool.query(`insert into assets (kind, original_name, mime, bytes, sha256, storage_ref, source, rights) values ('image','a','image/png',1,$1,'r','upload','{"attestations":[]}')`, [sha("b")]),
    ).rejects.toThrow();
  });
});
