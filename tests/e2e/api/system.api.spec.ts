import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { endSessionPool, mintSession } from "../fixtures/sessions";

// /settings/system is a page plus two server actions. These tests post to the REAL action ids (read from the build's
// server-reference manifest), so a request that gets through would really change the setting.
const port = process.env.E2E_PORT!;
const ORIGIN = `http://127.0.0.1:${port}`;
let pool: pg.Pool | undefined;
const db = () => (pool ??= new pg.Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 1 }));
test.afterAll(async () => {
  await pool?.end();
  pool = undefined;
  await endSessionPool();
});

function actionId(name: string): string {
  const m = JSON.parse(readFileSync(path.resolve(".next/server/server-reference-manifest.json"), "utf8")) as {
    node: Record<string, { exportedName: string; workers: Record<string, unknown> }>;
  };
  const hit = Object.entries(m.node).find(([, v]) => v.exportedName === name && Object.keys(v.workers).some((w) => w.includes("settings/system")));
  if (!hit) throw new Error(`server action ${name} not found in the build manifest`);
  return hit[0];
}

const value = async (key: string): Promise<unknown> => (await db().query("select value from settings where key = $1", [key])).rows[0]?.value;
async function seed(key: string, v: unknown) {
  await db().query(
    "insert into settings (key, value, updated_by) values ($1, $2::jsonb, 'session') on conflict (key) do update set value = excluded.value",
    [key, JSON.stringify(v)],
  );
}

// The wire format useActionState produces: field 0 is the argument list (previous state, FormData as $K1) and the form's
// own fields travel as _1_<name>.
function post(request: APIRequestContext, name: string, fields: Record<string, string>, o: { cookie?: string; origin?: string }) {
  const multipart = new FormData(); // same order as the browser: the form's fields, then the argument list
  for (const [k, v] of Object.entries(fields)) multipart.append(`_1_${k}`, v);
  multipart.append("0", '[{},"$K1"]');
  return request.post("/settings/system", {
    maxRedirects: 0,
    multipart,
    headers: {
      "next-action": actionId(name),
      accept: "text/x-component",
      ...(o.origin ? { origin: o.origin } : {}),
      ...(o.cookie ? { cookie: `ytstudio_session=${o.cookie}` } : {}),
    },
  });
}

// The action's own success answer; a refusal, a redirect to /login or an Origin error never contains it.
const succeeded = async (res: Awaited<ReturnType<typeof post>>) => (await res.text()).includes('"ok":true');

test("anonymous page request is sent to login, with no system data in the body", async ({ request }) => {
  const res = await request.get("/settings/system", { maxRedirects: 0 });
  expect(res.status()).toBe(307);
  expect(res.headers().location).toContain("/login");
  expect(await res.text()).not.toMatch(/Local services|postgres|Key vault/);
});

test("positive control: with a session and the right Origin the real action changes the list", async ({ request }) => {
  await seed("network.local_services", ["localhost:11434"]);
  const token = await mintSession();
  const res = await post(request, "saveLocalServicesAction", { services: "localhost:22434" }, { cookie: token, origin: ORIGIN });
  expect(await succeeded(res)).toBe(true);
  expect(await value("network.local_services")).toEqual(["localhost:22434"]);
});

test("no session: the real save actions change nothing and are sent to login", async ({ request }) => {
  await seed("network.local_services", ["localhost:11434"]);
  await seed("jobs.concurrent_jobs", 2);
  const list = await post(request, "saveLocalServicesAction", { services: "" }, { origin: ORIGIN });
  expect(await succeeded(list)).toBe(false);
  const limits = await post(request, "saveLimitsAction", { concurrent_renders: "4", concurrent_jobs: "9", storage_warn_gb: "9", max_long_minutes: "9" }, { origin: ORIGIN });
  expect(await succeeded(limits)).toBe(false);
  expect(await value("network.local_services")).toEqual(["localhost:11434"]);
  expect(await value("jobs.concurrent_jobs")).toBe(2);
});

test("a garbage or revoked session cookie behaves like no session", async ({ request }) => {
  await seed("network.local_services", ["localhost:11434"]);
  const res = await post(request, "saveLocalServicesAction", { services: "" }, { cookie: "garbage-token", origin: ORIGIN });
  expect(await succeeded(res)).toBe(false);
  expect(await value("network.local_services")).toEqual(["localhost:11434"]);
});

test("a valid session with a foreign Origin is refused and nothing changes", async ({ request }) => {
  await seed("network.local_services", ["localhost:11434"]);
  const token = await mintSession();
  const res = await post(request, "saveLocalServicesAction", { services: "" }, { cookie: token, origin: "http://evil.test" });
  expect(await succeeded(res)).toBe(false);
  expect(await value("network.local_services")).toEqual(["localhost:11434"]);
  // A request with no Origin at all is not a browser cross-site post (browsers always send Origin on those) and Next lets it
  // through; the session cookie is SameSite=Lax. It is not tested as "refused" on purpose.
});

test("an over-long or missing list field is an error, never an empty list", async ({ request }) => {
  await seed("network.local_services", ["localhost:11434"]);
  const token = await mintSession();
  await post(request, "saveLocalServicesAction", { services: "a".repeat(10_001) }, { cookie: token, origin: ORIGIN });
  expect(await value("network.local_services")).toEqual(["localhost:11434"]);
  await post(request, "saveLocalServicesAction", {}, { cookie: token, origin: ORIGIN });
  expect(await value("network.local_services")).toEqual(["localhost:11434"]);
});

test("hostile entries sent to the real action are refused with a session too", async ({ request }) => {
  await seed("network.local_services", ["localhost:11434"]);
  const token = await mintSession();
  for (const bad of ["0.0.0.0:11434", "127.0.0.1:5432", "[::]:80", "2130706433:80", "169.254.169.254:80"]) {
    await post(request, "saveLocalServicesAction", { services: `localhost:11434\n${bad}` }, { cookie: token, origin: ORIGIN });
    expect(await value("network.local_services"), bad).toEqual(["localhost:11434"]);
  }
});
