import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, request, test } from "@playwright/test";
import { endSessionPool, mintSession } from "../fixtures/sessions";

// Clip Factory upload route: a video file to cut clips from. Session and Host/Origin are checked before the body is read, the language is checked
// before the body is read, and the first bytes must look like a video. There is no worker in the e2e run, so an accepted upload stays queued.
const ORIGIN = `http://127.0.0.1:${process.env.E2E_PORT!}`;
test.afterAll(endSessionPool);
const MP4 = readFileSync(path.join(process.cwd(), "tests/fixtures/video/good.mp4"));
const send = (token: string | null, data: Buffer, o: { origin?: string; language?: string | null } = {}) =>
  request.newContext({ baseURL: ORIGIN }).then((ctx) =>
    ctx.post(`/api/clip-sources${o.language === null ? "" : `?language=${o.language ?? "en"}`}`, {
      data,
      headers: { origin: o.origin ?? ORIGIN, "content-type": "application/octet-stream", "x-file-name": encodeURIComponent("My talk.mp4"), ...(token && { cookie: `ytstudio_session=${token}` }) },
      timeout: 120_000,
    }),
  );

test("unauthenticated upload is refused before the body is read", async () => {
  expect((await send(null, MP4)).status()).toBe(401);
});

test("wrong origin is refused (with a valid session)", async () => {
  expect((await send(await mintSession(), MP4, { origin: "http://evil.test" })).status()).toBe(403);
});

test("a missing or unknown language is refused", async () => {
  const token = await mintSession();
  expect((await send(token, MP4, { language: null })).status()).toBe(400);
  expect((await send(token, MP4, { language: "xx" })).status()).toBe(400);
});

test("a file that is not a video (a playlist, text, an image) is refused by its first bytes", async () => {
  const token = await mintSession();
  for (const body of ["#EXTM3U\n#EXTINF:10,\n/etc/hosts\n", "hello, not a video at all", "GIF89a......"]) {
    const res = await send(token, Buffer.from(body));
    expect(res.status(), body).toBe(415);
    expect((await res.json()).message).toMatch(/not an mp4, mov, mkv or webm/);
  }
});

test("a real mp4 is accepted: a done video row appears and the ingest step is queued", async () => {
  const res = await send(await mintSession(), MP4);
  expect(res.status()).toBe(201);
  const j = await res.json();
  expect(j.status).toBe("queued");
  expect(j.videoId).toMatch(/^[0-9a-f-]{36}$/);
});
