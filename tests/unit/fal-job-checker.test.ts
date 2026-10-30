import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createFalJobChecker } from "@/server/providers/image/fal";
import type { SafeFetch } from "@/server/providers/voice/eleven-types";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const ID = "req-1234abcd";
const j = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
const root = realpathSync(mkdtempSync(path.join(tmpdir(), "falchk-")));

function checker(api: (url: string, method: string) => Response | Error) {
  const urls: string[] = [];
  const auth: Record<string, unknown> = {};
  const mk = (cdn: boolean): SafeFetch => async (url, init) => {
    urls.push(`${init.method} ${url}`);
    auth[cdn ? "cdn" : "api"] = Object.keys((init.headers ?? {}) as object).map((k) => k.toLowerCase()).includes("authorization");
    const r = cdn ? new Response(PNG) : api(url, init.method ?? "GET");
    if (r instanceof Error) throw r;
    return r;
  };
  return { urls, auth, c: createFalJobChecker({ fetch: mk(false), fetchCdn: mk(true), getKey: async () => "k", root }) };
}
const job = { providerJobId: ID, quoteMicroUsd: 3000 };
const R = `https://queue.fal.run/fal-ai/flux/requests/${ID}`;

describe("createFalJobChecker", () => {
  it("done_saves_the_file_and_only_ever_reads", async () => {
    const { c, urls } = checker((u) => (u.endsWith("/status") ? j({ status: "COMPLETED" }) : j({ images: [{ url: "https://v3.fal.media/f/a.png" }], prompt: "a fox" })));
    const o = await c.check(job);
    expect(o).toMatchObject({ kind: "done", artifact: { bytes: PNG.length, provenance: { provider: "fal_image", priceMicroUsd: 3000 } } });
    expect(urls.every((u) => u.startsWith("GET "))).toBe(true);
    expect(urls).toContain(`GET ${R}/status`);
  });
  it("the_cdn_download_carries_no_authorization_header", async () => {
    const { c, auth } = checker((u) => (u.endsWith("/status") ? j({ status: "COMPLETED" }) : j({ images: [{ url: "https://v3.fal.media/f/a.png" }] })));
    expect((await c.check(job)).kind).toBe("done");
    expect(auth).toEqual({ api: true, cdn: false });
  });
  it("running", async () => {
    for (const status of ["IN_QUEUE", "IN_PROGRESS"]) expect(await checker(() => j({ status })).c.check(job)).toEqual({ kind: "running" });
  });
  it("only_a_clear_answer_is_failed", async () => {
    expect((await checker(() => j({}, 404)).c.check(job)).kind).toBe("failed");
    expect((await checker(() => j({ status: "COMPLETED", error: "bad" })).c.check(job)).kind).toBe("failed");
  });
  it("everything_else_is_unknown", async () => {
    expect(await checker(() => j({}, 503)).c.check(job)).toEqual({ kind: "unknown" });
    expect(await checker(() => j({}, 401)).c.check(job)).toEqual({ kind: "unknown" });
    expect(await checker(() => new Error("net")).c.check(job)).toEqual({ kind: "unknown" });
    expect(await checker(() => j({ status: "WEIRD" })).c.check(job)).toEqual({ kind: "unknown" });
    expect(await checker((u) => (u.endsWith("/status") ? j({ status: "COMPLETED" }) : j({ images: [{ url: "https://evil.example/a.png" }] }))).c.check(job)).toEqual({ kind: "unknown" });
    expect(await checker(() => j({})).c.check({ ...job, providerJobId: "../x" })).toEqual({ kind: "unknown" });
  });
});
