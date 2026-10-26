import pg from "pg";
import { expect, test } from "@playwright/test";

// /settings/system is a page plus two server actions. Without a session neither may read or change anything.
const port = process.env.E2E_PORT!;
const ORIGIN = `http://127.0.0.1:${port}`;
let pool: pg.Pool | undefined;
const db = () => (pool ??= new pg.Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 1 }));
test.afterAll(async () => {
  await pool?.end();
  pool = undefined;
});

const listValue = async () => (await db().query("select value from settings where key = 'network.local_services'")).rows[0]?.value ?? [];

test("anonymous page request is sent to login, with no system data in the body", async ({ request }) => {
  const res = await request.get("/settings/system", { maxRedirects: 0 });
  expect(res.status()).toBe(307);
  expect(res.headers().location).toContain("/login");
  expect(await res.text()).not.toMatch(/Local services|postgres|Key vault/);
});

test("anonymous server-action post does not change the allow-list", async ({ request }) => {
  const before = await listValue();
  const res = await request.post("/settings/system", {
    maxRedirects: 0,
    headers: { origin: ORIGIN, "next-action": "0".repeat(40), "content-type": "text/plain;charset=UTF-8" },
    data: JSON.stringify([{}, "localhost:11434"]),
  });
  expect([307, 401, 403, 404]).toContain(res.status());
  expect(await listValue()).toEqual(before);
});

test("a wrong-origin post is refused", async ({ request }) => {
  const res = await request.post("/settings/system", {
    maxRedirects: 0,
    headers: { origin: "http://evil.test", "next-action": "0".repeat(40), "content-type": "text/plain;charset=UTF-8" },
    data: "[]",
  });
  expect(res.status()).not.toBe(200);
});
