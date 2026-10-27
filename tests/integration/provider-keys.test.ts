import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeKeyring, VaultError } from "@/server/core/vault-crypto";
import { getSecret } from "@/server/db/vault";
import { getVaultState, listProviderKeys, removeProviderKey, saveProviderKey, testProviderKey } from "@/server/db/provider-keys";
import { safeFetch } from "@/server/providers/net/safe-fetch";
import { withTestDb, type TestDb } from "../support/db";

let db: TestDb;
const b64 = () => randomBytes(32).toString("base64");
const K1 = b64();
const loader = () => makeKeyring(K1);
const KEY = "sk-ant-api03-TESTKEY-NEVER-LEAK-9f8e7d6c5b4a";
const KEY2 = "sk-ant-api03-SECONDKEY-NEVER-LEAK-0a1b2c3d4e5f";

beforeAll(async () => {
  db = await withTestDb();
});
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  await db.ownerPool.query("truncate secrets");
  await db.ownerPool.query("truncate audit_log restart identity");
});
afterEach(() => vi.restoreAllMocks());

const audit = async () => (await db.ownerPool.query("select event, detail from audit_log order by id")).rows as Array<{ event: string; detail: Record<string, unknown> }>;
const everything = async () => {
  const s = await db.ownerPool.query("select t::text s from secrets t");
  const a = await db.ownerPool.query("select t::text s from audit_log t");
  return JSON.stringify([s.rows, a.rows]);
};

describe("save", () => {
  it("stores through the vault, lists a masked tail only, audits provider and tail without the key", async () => {
    const logs: string[] = [];
    for (const m of ["log", "error", "warn", "info"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
    expect(await saveProviderKey(db.pool, loader, "anthropic", KEY)).toEqual({ ok: true });
    expect(await getSecret(db.pool, loader(), "provider.anthropic.api_key")).toBe(KEY);
    const list = await listProviderKeys(db.pool);
    const a = list.find((r) => r.id === "anthropic")!;
    expect(a).toMatchObject({ isSet: true, tail: KEY.slice(-4), lastTest: null });
    expect(JSON.stringify(list)).not.toContain(KEY);
    expect(list.filter((r) => r.isSet)).toHaveLength(1);
    expect(await audit()).toEqual([{ event: "key.set", detail: { provider: "anthropic", tail: KEY.slice(-4), replaced: false } }]);
    expect(await everything()).not.toContain("NEVER-LEAK");
    expect(logs.join("\n")).not.toContain("NEVER-LEAK");
  });

  it("replacing audits replaced:true and resets the last test", async () => {
    await saveProviderKey(db.pool, loader, "anthropic", KEY);
    await testProviderKey(db.pool, loader, "anthropic", { fetcher: async () => new Response("{}", { status: 200 }) });
    expect((await listProviderKeys(db.pool)).find((r) => r.id === "anthropic")!.lastTest?.result).toBe("ok");
    await saveProviderKey(db.pool, loader, "anthropic", KEY2);
    const row = (await listProviderKeys(db.pool)).find((r) => r.id === "anthropic")!;
    expect(row.tail).toBe(KEY2.slice(-4));
    expect(row.lastTest).toBeNull();
    expect(await getSecret(db.pool, loader(), "provider.anthropic.api_key")).toBe(KEY2);
    expect((await audit()).map((r) => r.detail.replaced).filter((x) => x !== undefined)).toEqual([false, true]);
    expect(await everything()).not.toContain("NEVER-LEAK");
  });

  it("garbage is refused before anything is written or audited", async () => {
    const r = await saveProviderKey(db.pool, loader, "anthropic", "hello");
    expect(r.ok).toBe(false);
    expect(await saveProviderKey(db.pool, loader, "nope" as never, KEY)).toMatchObject({ ok: false });
    expect((await db.ownerPool.query("select 1 from secrets")).rowCount).toBe(0);
    expect(await audit()).toEqual([]);
  });

  it("fails closed with no master key: nothing stored, nothing audited", async () => {
    const none = () => {
      throw new VaultError("bad_key");
    };
    expect(await getVaultState(db.pool, none as never)).toBe("missing_key");
    const r = await saveProviderKey(db.pool, none as never, "anthropic", KEY);
    expect(r).toMatchObject({ ok: false });
    expect((await db.ownerPool.query("select 1 from secrets")).rowCount).toBe(0);
    expect(await audit()).toEqual([]);
  });

  it("fails closed with the wrong master key: the existing entry is not overwritten", async () => {
    await saveProviderKey(db.pool, loader, "anthropic", KEY);
    const wrong = () => makeKeyring(b64());
    expect(await getVaultState(db.pool, wrong)).toBe("wrong_key");
    const r = await saveProviderKey(db.pool, wrong, "openai", "sk-abcdefghijklmnopqrstuvwxyz0123");
    expect(r.ok).toBe(false);
    expect((await db.ownerPool.query("select name from secrets")).rows).toEqual([{ name: "provider.anthropic.api_key" }]);
    expect(await getSecret(db.pool, loader(), "provider.anthropic.api_key")).toBe(KEY);
  });
});

describe("remove", () => {
  it("removes, lists not set, audits once without secrets; removing again is a quiet no-op", async () => {
    await saveProviderKey(db.pool, loader, "anthropic", KEY);
    expect(await removeProviderKey(db.pool, "anthropic")).toEqual({ ok: true });
    const row = (await listProviderKeys(db.pool)).find((r) => r.id === "anthropic")!;
    expect(row).toMatchObject({ isSet: false, tail: "", lastTest: null });
    expect(await removeProviderKey(db.pool, "anthropic")).toEqual({ ok: true });
    expect((await audit()).map((r) => r.event)).toEqual(["key.set", "key.removed"]);
    expect(await everything()).not.toContain("NEVER-LEAK");
  });
  it("only touches provider keys, never another vault entry", async () => {
    await db.ownerPool.query("insert into secrets (name, ciphertext, nonce, key_id) values ('totp.secret', decode(repeat('00', 20), 'hex'), decode(repeat('00', 12), 'hex'), 'deadbeef')");
    expect(await removeProviderKey(db.pool, "../totp.secret" as never)).toMatchObject({ ok: false });
    expect((await db.ownerPool.query("select 1 from secrets where name = 'totp.secret'")).rowCount).toBe(1);
  });
});

describe("test", () => {
  let srv: Server;
  let port: number;
  let seenAuth: string | undefined;
  beforeAll(async () => {
    srv = createServer((req, res) => {
      seenAuth = req.headers["x-api-key"] as string | undefined;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ echoed: seenAuth }));
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    port = (srv.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => srv.close(() => r())));

  it("sends the stored key to the provider, records the verdict as audit + last test, never the body", async () => {
    await saveProviderKey(db.pool, loader, "anthropic", KEY);
    const r = await testProviderKey(db.pool, loader, "anthropic", {
      fetcher: (url, init, o) => safeFetch(`http://127.0.0.1:${port}${new URL(url).pathname}`, init, { mode: "typed", localServices: [`127.0.0.1:${port}`], ...o }),
    });
    expect(r).toEqual({ ok: true, result: "ok" });
    expect(seenAuth).toBe(KEY);
    expect(JSON.stringify(r)).not.toContain("NEVER-LEAK");
    const row = (await listProviderKeys(db.pool)).find((x) => x.id === "anthropic")!;
    expect(row.lastTest?.result).toBe("ok");
    expect(row.lastTest?.at).toBeInstanceOf(Date);
    expect((await audit()).at(-1)).toEqual({ event: "key.tested", detail: { provider: "anthropic", result: "ok" } });
    expect(await everything()).not.toContain("NEVER-LEAK");
  });

  it("rejected and unreachable are recorded; a network failure never shows the error body", async () => {
    await saveProviderKey(db.pool, loader, "anthropic", KEY);
    const rej = await testProviderKey(db.pool, loader, "anthropic", { cooldownMs: 0, fetcher: async () => new Response(KEY, { status: 401 }) });
    expect(rej).toEqual({ ok: true, result: "rejected" });
    const down = await testProviderKey(db.pool, loader, "anthropic", {
      cooldownMs: 0,
      fetcher: async () => {
        throw new Error(`boom ${KEY}`);
      },
    });
    expect(down).toEqual({ ok: true, result: "unreachable" });
    expect((await listProviderKeys(db.pool)).find((x) => x.id === "anthropic")!.lastTest?.result).toBe("unreachable");
    expect(await everything()).not.toContain("NEVER-LEAK");
  });

  it("testing a provider with no key makes no request", async () => {
    const fetcher = vi.fn();
    expect(await testProviderKey(db.pool, loader, "openai", { fetcher })).toMatchObject({ ok: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("with the wrong master key no request is made", async () => {
    await saveProviderKey(db.pool, loader, "anthropic", KEY);
    const fetcher = vi.fn();
    expect(await testProviderKey(db.pool, () => makeKeyring(b64()), "anthropic", { fetcher })).toMatchObject({ ok: false });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("test cooldown (server side)", () => {
  const ok = () => vi.fn(async () => new Response("{}", { status: 200 }));
  it("a second test of the same provider inside the cooldown is refused with a fixed message and makes no request", async () => {
    await saveProviderKey(db.pool, loader, "anthropic", KEY);
    const f1 = ok();
    expect(await testProviderKey(db.pool, loader, "anthropic", { fetcher: f1 })).toEqual({ ok: true, result: "ok" });
    const f2 = ok();
    expect(await testProviderKey(db.pool, loader, "anthropic", { fetcher: f2 })).toEqual({ ok: false, message: "Try again shortly." });
    expect(f1).toHaveBeenCalledTimes(1);
    expect(f2).not.toHaveBeenCalled();
    expect((await audit()).filter((r) => r.event === "key.tested")).toHaveLength(1);
  });
  it("another provider is not held up by it", async () => {
    await saveProviderKey(db.pool, loader, "anthropic", KEY);
    await saveProviderKey(db.pool, loader, "openai", "sk-abcdefghijklmnopqrstuvwxyz0123");
    await testProviderKey(db.pool, loader, "anthropic", { fetcher: ok() });
    expect(await testProviderKey(db.pool, loader, "openai", { fetcher: ok() })).toEqual({ ok: true, result: "ok" });
  });
  it("it lifts once the cooldown has passed", async () => {
    await saveProviderKey(db.pool, loader, "anthropic", KEY);
    await testProviderKey(db.pool, loader, "anthropic", { fetcher: ok() });
    await new Promise((r) => setTimeout(r, 60));
    const r = await testProviderKey(db.pool, loader, "anthropic", { fetcher: ok(), cooldownMs: 30 });
    expect(r).toEqual({ ok: true, result: "ok" });
  });
});
