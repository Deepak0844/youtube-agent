import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { checkKeyShape, isServiceAccountJson, keyTestRequest, PROVIDERS } from "@/server/core/provider-keys";
import { fetchAccessToken, parseServiceAccount, signedAssertion, TOKEN_URL } from "@/server/providers/video/google-auth";
import { NotProcessedError } from "@/server/core/error-class";

const pem = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
export const saJson = (o: Record<string, unknown> = {}) => JSON.stringify({ type: "service_account", project_id: "my-video-project", client_email: "bot@my-video-project.iam.gserviceaccount.com", private_key: pem.privateKey, ...o });

describe("video key slots", () => {
  it("are listed under Video and have no free key test", () => {
    for (const id of ["seedance", "kling", "vertex"] as const) {
      expect(PROVIDERS.find((p) => p.id === id)?.role).toBe("Video");
      expect(keyTestRequest(id, "x")).toBeNull();
    }
  });
  it("seedance and kling take a visible 16+ character key and refuse spaces, short and empty", () => {
    for (const id of ["seedance", "kling"]) {
      expect(checkKeyShape(id, "  abcdefghijklmnop1234  ")).toEqual({ ok: true, value: "abcdefghijklmnop1234" });
      for (const bad of ["short", "has space inside the key 123", "", "   "]) expect(checkKeyShape(id, bad).ok).toBe(false);
    }
  });
  it("vertex takes a whole service-account file (longer than the usual cap) and refuses anything else, without echoing it", () => {
    const good = saJson();
    expect(good.length).toBeGreaterThan(400);
    expect(checkKeyShape("vertex", good).ok).toBe(true);
    for (const bad of [saJson({ type: "authorized_user" }), saJson({ private_key: "not a key" }), saJson({ project_id: "X Y" }), saJson({ client_email: "nope" }), "{not json}", "plain text", "{" + "x".repeat(7000) + "}"]) {
      const r = checkKeyShape("vertex", bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).not.toContain("BEGIN PRIVATE KEY");
    }
    expect(isServiceAccountJson("null")).toBe(false);
  });
});

describe("Google service-account sign-in", () => {
  const sa = parseServiceAccount(saJson());
  it("signs a three-part RS256 assertion with the account as issuer and a one-hour life", () => {
    const [h, c, sig] = signedAssertion(sa, 1_700_000_000).split(".");
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(c!, "base64url").toString())).toEqual({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud: TOKEN_URL, iat: 1_700_000_000, exp: 1_700_003_600 });
    expect(sig!.length).toBeGreaterThan(300);
  });
  it("a bad file or key is refused before any request", () => {
    expect(() => parseServiceAccount("{}")).toThrow(NotProcessedError);
    expect(() => parseServiceAccount("nope")).toThrow(NotProcessedError);
    expect(() => signedAssertion({ ...sa, private_key: "junk" }, 1)).toThrow();
  });
  it("swaps it for a token, and refuses a refusal, a bad answer and a bad token without leaking the key", async () => {
    const ok = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status });
    const sig = new AbortController().signal;
    const calls: Array<{ url: string; body: string }> = [];
    const f = (async (url: string, init: RequestInit) => { calls.push({ url, body: String(init.body) }); return (await ok({ access_token: "ya29.abcdefghijklmnopqrstuvwxyz" })()); }) as never;
    expect(await fetchAccessToken(f, sa, 1_700_000_000, sig)).toBe("ya29.abcdefghijklmnopqrstuvwxyz");
    expect(calls[0]!.url).toBe(TOKEN_URL);
    expect(calls[0]!.body).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer");
    for (const f2 of [ok({}, 401), ok({ error: "invalid_grant" }, 400), ok({ access_token: "short" }), ok({ access_token: "has a space in it, not a token" }), async () => new Response("<html>", { status: 200 })]) {
      const e = await fetchAccessToken(f2 as never, sa, 1, sig).catch((x) => x);
      expect(e).toBeInstanceOf(NotProcessedError);
      expect(String(e.message)).not.toContain("PRIVATE KEY");
    }
    const down = (async () => { throw new Error("ECONNRESET"); }) as never;
    expect(await fetchAccessToken(down, sa, 1, sig).catch((x) => x)).toBeInstanceOf(NotProcessedError);
  });
});
