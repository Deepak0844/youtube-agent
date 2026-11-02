import { describe, expect, it } from "vitest";
import { createPictureFetcher, createPacer, fetchBounded, hostAllowed, PICTURE_MAX_BYTES } from "@/server/providers/stock/picture-download";

const HOSTS = ["upload.wikimedia.org", "thumb.wikimedia.org"];
const resp = (body: Uint8Array | string, init: { status?: number; headers?: Record<string, string> } = {}) =>
  new Response(body as BodyInit, { status: init.status ?? 200, headers: init.headers ?? { "content-type": "image/jpeg" } });
const sig = new AbortController().signal;
const opts = { hosts: HOSTS, maxBytes: 1000, accept: /^image\/(jpeg|png|webp)$/, signal: sig };

describe("hostAllowed", () => {
  it("allows only https on listed hosts", () => {
    expect(hostAllowed("https://upload.wikimedia.org/a.jpg", HOSTS)).not.toBeNull();
    expect(hostAllowed("http://upload.wikimedia.org/a.jpg", HOSTS)).toBeNull();
    expect(hostAllowed("https://evil.example/a.jpg", HOSTS)).toBeNull();
    expect(hostAllowed("https://upload.wikimedia.org.evil.example/a.jpg", HOSTS)).toBeNull();
    expect(hostAllowed("https://user:pw@upload.wikimedia.org/a.jpg", HOSTS)).toBeNull();
    expect(hostAllowed("https://upload.wikimedia.org:8443/a.jpg", HOSTS)).toBeNull();
    expect(hostAllowed("not a url", HOSTS)).toBeNull();
    expect(hostAllowed("https://upload.wikimedia.org./a.jpg", HOSTS)).toBeNull(); // trailing dot
    expect(hostAllowed("https://UPLOAD.wikimedia.org/a.jpg", HOSTS)?.hostname).toBe("upload.wikimedia.org"); // normalised
  });
});

describe("production wiring", () => {
  it("goes through safeFetch in indirect mode with no redirects and a timeout", async () => {
    let seen: { url: string; opts: unknown } | null = null;
    const f = createPictureFetcher((async (url: string, _init: unknown, opts: unknown) => { seen = { url, opts }; return new Response("x"); }) as never);
    await f("https://upload.wikimedia.org/a.jpg", {});
    expect(seen).toEqual({ url: "https://upload.wikimedia.org/a.jpg", opts: { mode: "indirect", maxRedirects: 0, timeoutMs: 30_000 } });
  });
  it("sends a User-Agent with a contact url", async () => {
    let ua = "";
    await fetchBounded(async (_u, init) => { ua = new Headers(init.headers).get("user-agent") ?? ""; return resp(new Uint8Array([1])); }, "https://upload.wikimedia.org/a.jpg", opts);
    expect(ua).toContain("https://github.com/Deepak0844/youtube-agent");
  });
});

describe("fetchBounded", () => {
  it("returns the bytes and sends a descriptive User-Agent", async () => {
    let ua = "";
    const r = await fetchBounded(async (_u, init) => { ua = new Headers(init.headers).get("user-agent") ?? ""; return resp(new Uint8Array([1, 2, 3])); }, "https://upload.wikimedia.org/a.jpg", opts);
    expect(r).toMatchObject({ ok: true });
    expect(ua).toMatch(/^YTStudio\//);
  });
  it("refuses an address off the list without calling the network", async () => {
    let called = 0;
    const r = await fetchBounded(async () => { called++; return resp("x"); }, "https://evil.example/a.jpg", opts);
    expect(r).toMatchObject({ ok: false, reason: "host" });
    expect(called).toBe(0);
  });
  it("follows a redirect inside the list but refuses one that leaves it or downgrades", async () => {
    const hop = (to: string) => async (u: string) => (u.endsWith("/start") ? resp("", { status: 302, headers: { location: to } }) : resp(new Uint8Array([1])));
    expect(await fetchBounded(hop("https://thumb.wikimedia.org/b.jpg"), "https://upload.wikimedia.org/start", opts)).toMatchObject({ ok: true });
    expect(await fetchBounded(hop("https://evil.example/b.jpg"), "https://upload.wikimedia.org/start", opts)).toMatchObject({ ok: false, reason: "host" });
    expect(await fetchBounded(hop("http://upload.wikimedia.org/b.jpg"), "https://upload.wikimedia.org/start", opts)).toMatchObject({ ok: false, reason: "host" });
  });
  it("stops a redirect loop", async () => {
    const r = await fetchBounded(async () => resp("", { status: 302, headers: { location: "https://upload.wikimedia.org/start" } }), "https://upload.wikimedia.org/start", opts);
    expect(r).toMatchObject({ ok: false, reason: "redirects" });
  });
  it("refuses an oversize body, by header and while streaming", async () => {
    expect(await fetchBounded(async () => resp("x", { headers: { "content-type": "image/jpeg", "content-length": "5000" } }), "https://upload.wikimedia.org/a.jpg", opts)).toMatchObject({ ok: false, reason: "too_big" });
    expect(await fetchBounded(async () => resp(new Uint8Array(2000)), "https://upload.wikimedia.org/a.jpg", opts)).toMatchObject({ ok: false, reason: "too_big" });
  });
  it("refuses a wrong content type and a bad status", async () => {
    expect(await fetchBounded(async () => resp("<html>", { headers: { "content-type": "text/html" } }), "https://upload.wikimedia.org/a.jpg", opts)).toMatchObject({ ok: false, reason: "type" });
    expect(await fetchBounded(async () => resp("x", { headers: { "content-type": "image/svg+xml" } }), "https://upload.wikimedia.org/a.jpg", opts)).toMatchObject({ ok: false, reason: "type" });
    expect(await fetchBounded(async () => resp("nope", { status: 404 }), "https://upload.wikimedia.org/a.jpg", opts)).toMatchObject({ ok: false, reason: "status" });
  });
  it("turns a network error into a plain refusal, never a throw", async () => {
    expect(await fetchBounded(async () => { throw new Error("ECONNRESET"); }, "https://upload.wikimedia.org/a.jpg", opts)).toMatchObject({ ok: false, reason: "network" });
  });
  it("has a 10 MB default cap", () => expect(PICTURE_MAX_BYTES).toBe(10 * 1024 * 1024));
});

describe("createPacer", () => {
  it("waits at least the gap between two requests to the same host, not between different hosts", async () => {
    let t = 0;
    const slept: number[] = [];
    const pace = createPacer({ minGapMs: 1000, now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; } });
    await pace("a.org", sig);
    await pace("a.org", sig);
    expect(slept).toEqual([1000]);
    await pace("b.org", sig);
    expect(slept).toEqual([1000]);
    t += 5000;
    await pace("a.org", sig);
    expect(slept).toEqual([1000]);
  });
  it("honours an aborted signal", async () => {
    const ac = new AbortController();
    ac.abort(new Error("stop"));
    const pace = createPacer({ minGapMs: 1000, now: () => 0, sleep: async () => undefined });
    await expect(pace("a.org", ac.signal)).rejects.toThrow("stop");
  });
});
