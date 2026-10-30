import { describe, expect, it } from "vitest";
import { createJobCheckers, falCdnFetch, hostedApiFetch } from "@/server/providers/image/wire";
import type { safeFetch } from "@/server/providers/net/safe-fetch";

const spy = () => {
  const calls: Array<{ url: string; headers: Headers; opts: Record<string, unknown> }> = [];
  const sf = (async (url: string, init: RequestInit, opts: Record<string, unknown>) => {
    calls.push({ url, headers: new Headers(init.headers), opts });
    return new Response("x");
  }) as unknown as typeof safeFetch;
  return { calls, sf };
};
const O = { timeoutMs: 1, maxRedirects: 0 };

describe("image wiring fetches", () => {
  it("fal cdn: https *.fal.media only, indirect mode, key stripped", async () => {
    const { calls, sf } = spy();
    await falCdnFetch(sf)("https://v3.fal.media/f/a.png", { headers: { Authorization: "Key secret" } }, O);
    expect(calls[0]!.opts).toMatchObject({ mode: "indirect", maxRedirects: 0 });
    expect(calls[0]!.headers.get("authorization")).toBeNull();
  });
  it.each(["http://v3.fal.media/a.png", "https://evil.example/a.png", "https://fal.media.evil.example/a", "https://127.0.0.1/a", "https://v3.fal.media:8443/a", "https://u:p@v3.fal.media/a"])("fal cdn refuses %s", async (u) => {
    const { calls, sf } = spy();
    await expect(falCdnFetch(sf)(u, {}, O)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
  it("hosted api calls are typed with no local services", async () => {
    const { calls, sf } = spy();
    await hostedApiFetch(sf)("https://queue.fal.run/x", {}, O);
    expect(calls[0]!.opts).toMatchObject({ mode: "typed", localServices: [], maxRedirects: 0 });
  });
  it("only fal has a job checker", () => {
    expect(Object.keys(createJobCheckers({} as never, (() => ({})) as never, "/tmp"))).toEqual(["fal_image"]);
  });
});
