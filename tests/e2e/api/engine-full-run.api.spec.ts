import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { endSessionPool, mintSession } from "../fixtures/sessions";
import { advance, db, endQueuePool, liveFields, seedPublishGate, seedScriptGate, workerFinishes } from "../fixtures/queue";

const ORIGIN = `http://127.0.0.1:${process.env.E2E_PORT!}`;

test.afterAll(async () => {
  await endQueuePool();
  await endSessionPool();
});

function actionId(name: string): string {
  const manifest = JSON.parse(readFileSync(path.resolve(".next/server/server-reference-manifest.json"), "utf8")) as {
    node: Record<string, { exportedName: string; workers: Record<string, unknown> }>;
  };
  const hit = Object.entries(manifest.node).find(([, value]) => value.exportedName === name && Object.keys(value.workers).some((worker) => worker.includes("queue")));
  if (!hit) throw new Error(`server action ${name} not found`);
  return hit[0];
}

async function postAction(request: APIRequestContext, name: string, fields: Record<string, string>, token: string) {
  const multipart = new FormData();
  for (const [key, value] of Object.entries(fields)) multipart.append(`_1_${key}`, value);
  multipart.append("0", '[{},"$K1"]');
  return request.post("/queue", {
    maxRedirects: 0,
    multipart,
    headers: { "next-action": actionId(name), accept: "text/x-component", origin: ORIGIN, cookie: `ytstudio_session=${token}` },
  });
}

const ok = async (response: Awaited<ReturnType<typeof postAction>>) => (await response.text()).includes('"ok":true');

test("the owner advances a new short through script and cost over HTTP", async ({ request }) => {
  const topic = `api-engine-${Date.now()}`;
  const { videoId } = await seedScriptGate(topic, { withCost: true });
  const token = await mintSession();

  expect(await ok(await postAction(request, "approveGateAction", await liveFields(videoId, "script"), token))).toBe(true);
  expect(await workerFinishes(videoId, "build")).toBe(true);
  await advance(videoId);
  expect(await ok(await postAction(request, "approveGateAction", await liveFields(videoId, "cost"), token))).toBe(true);

  const approvals = await db().query<{ gate: string }>("select gate from approvals where video_id = $1 and decision = 'approved' order by seq", [videoId]);
  expect(approvals.rows.map((row) => row.gate)).toEqual(["script", "cost"]);
  expect((await db().query("select status from stage_runs where video_id = $1 and name = 'generate'", [videoId])).rows[0]?.status).toBe("queued");
});

test("the rendered short is publish-approved once over HTTP", async ({ request }) => {
  const { videoId } = await seedPublishGate(`api-publish-${Date.now()}`);
  const token = await mintSession();
  const fields = await liveFields(videoId, "publish");

  expect(await ok(await postAction(request, "approveGateAction", fields, token))).toBe(true);
  expect(await ok(await postAction(request, "approveGateAction", fields, token))).toBe(false);
  const uploads = await db().query<{ status: string }>("select status from uploads where video_id = $1", [videoId]);
  expect(uploads.rows).toEqual([{ status: "publish_approved" }]);
});
