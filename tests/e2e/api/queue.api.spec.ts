import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { endSessionPool, expireSession, mintSession, revokeSession } from "../fixtures/sessions";
import { db, endQueuePool, liveFields, seedParked, seedPublishGate, seedScriptGate } from "../fixtures/queue";

// The /queue actions, posted to their REAL ids (read from the build's server-reference manifest). A request that gets
// through would really approve, cancel or release something, so every refusal is checked against the database.
const port = process.env.E2E_PORT!;
const ORIGIN = `http://127.0.0.1:${port}`;
test.afterAll(async () => {
  await endQueuePool();
  await endSessionPool();
});

function actionId(name: string): string {
  const m = JSON.parse(readFileSync(path.resolve(".next/server/server-reference-manifest.json"), "utf8")) as {
    node: Record<string, { exportedName: string; workers: Record<string, unknown> }>;
  };
  const hit = Object.entries(m.node).find(([, v]) => v.exportedName === name && Object.keys(v.workers).some((w) => w.includes("queue")));
  if (!hit) throw new Error(`server action ${name} not found in the build manifest`);
  return hit[0];
}

// The wire format useActionState produces: field 0 is the argument list (previous state, FormData as $K1); the form's own
// fields travel as _1_<name>.
function post(request: APIRequestContext, name: string, fields: Record<string, string>, o: { cookie?: string; origin?: string; headers?: Record<string, string> } = {}) {
  const multipart = new FormData();
  for (const [k, v] of Object.entries(fields)) multipart.append(`_1_${k}`, v);
  multipart.append("0", '[{},"$K1"]');
  return request.post("/queue", {
    maxRedirects: 0,
    multipart,
    headers: {
      "next-action": actionId(name),
      accept: "text/x-component",
      ...(o.origin ? { origin: o.origin } : {}),
      ...(o.cookie ? { cookie: `ytstudio_session=${o.cookie}` } : {}),
      ...(o.headers ?? {}),
    },
  });
}
const succeeded = async (res: Awaited<ReturnType<typeof post>>) => (await res.text()).includes('"ok":true');

const count = async (sql: string, args: unknown[] = []) => Number((await db().query(sql, args)).rows[0].n);
const approvals = (videoId: string) => count("select count(*)::int as n from approvals where video_id = $1", [videoId]);
const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

test.describe("approve", () => {
  test("positive control: a session with the page's own fields approves, once", async ({ request }) => {
    const { videoId } = await seedScriptGate(`approve-${stamp()}`);
    const f = await liveFields(videoId, "script");
    const token = await mintSession();
    expect(await succeeded(await post(request, "approveGateAction", f, { cookie: token, origin: ORIGIN }))).toBe(true);
    expect(await approvals(videoId)).toBe(1);
    // Replaying the same page after the video moved on is refused and adds nothing.
    expect(await succeeded(await post(request, "approveGateAction", f, { cookie: token, origin: ORIGIN }))).toBe(false);
    expect(await approvals(videoId)).toBe(1);
  });

  test("no session, a garbage, expired or revoked session, or a bearer header: refused, nothing changes", async ({ request }) => {
    const { videoId } = await seedScriptGate(`nosession-${stamp()}`);
    const f = await liveFields(videoId, "script");
    const expired = await mintSession();
    await expireSession(expired);
    const revoked = await mintSession();
    await revokeSession(revoked);
    const tries = [
      { origin: ORIGIN },
      { origin: ORIGIN, cookie: "garbage-token" },
      { origin: ORIGIN, cookie: expired },
      { origin: ORIGIN, cookie: revoked },
      { origin: ORIGIN, headers: { authorization: "Bearer ytstudio_token_not_a_thing" } },
    ];
    for (const o of tries) expect(await succeeded(await post(request, "approveGateAction", f, o)), JSON.stringify(o)).toBe(false);
    expect(await approvals(videoId)).toBe(0);
  });

  test("a valid session with a foreign Origin, or with no Origin at all, is refused", async ({ request }) => {
    const { videoId } = await seedScriptGate(`origin-${stamp()}`);
    const f = await liveFields(videoId, "script");
    const token = await mintSession();
    expect(await succeeded(await post(request, "approveGateAction", f, { cookie: token, origin: "http://evil.test" }))).toBe(false);
    expect(await succeeded(await post(request, "approveGateAction", f, { cookie: token }))).toBe(false);
    expect(await approvals(videoId)).toBe(0);
  });

  test("a forged, missing or malformed hash is refused with a session", async ({ request }) => {
    const { videoId } = await seedScriptGate(`forged-${stamp()}`);
    const f = await liveFields(videoId, "script");
    const token = await mintSession();
    for (const seenHash of ["0".repeat(64), "f".repeat(64), "abc", "", `${f.seenHash}x`]) {
      expect(await succeeded(await post(request, "approveGateAction", { ...f, seenHash }, { cookie: token, origin: ORIGIN })), seenHash).toBe(false);
    }
    const noHash: Record<string, string> = { ...f };
    delete noHash.seenHash;
    expect(await succeeded(await post(request, "approveGateAction", noHash, { cookie: token, origin: ORIGIN }))).toBe(false);
    expect(await approvals(videoId)).toBe(0);
  });

  test("the right hash with other content versions is refused", async ({ request }) => {
    const { videoId } = await seedScriptGate(`versions-${stamp()}`);
    const f = await liveFields(videoId, "script");
    const token = await mintSession();
    const other = f.seenVersions.replace(/:1$/, ":9");
    expect(other).not.toBe(f.seenVersions);
    expect(await succeeded(await post(request, "approveGateAction", { ...f, seenVersions: other }, { cookie: token, origin: ORIGIN }))).toBe(false);
    expect(await approvals(videoId)).toBe(0);
  });

  test("a gate that is not the video's current one cannot be approved from a stale page", async ({ request }) => {
    const { videoId } = await seedScriptGate(`wronggate-${stamp()}`);
    const f = await liveFields(videoId, "script");
    const token = await mintSession();
    for (const gate of ["video", "evidence", "outline", "nonsense"]) {
      expect(await succeeded(await post(request, "approveGateAction", { ...f, gate }, { cookie: token, origin: ORIGIN })), gate).toBe(false);
    }
    expect(await approvals(videoId)).toBe(0);
  });
});

test.describe("send back", () => {
  test("needs a session, a hash and a 3 to 1000 character note; then reruns the draft", async ({ request }) => {
    const { videoId } = await seedScriptGate(`sendback-${stamp()}`);
    const f = await liveFields(videoId, "script");
    const token = await mintSession();
    expect(await succeeded(await post(request, "sendBackAction", { ...f, note: "make it shorter" }, { origin: ORIGIN }))).toBe(false);
    for (const note of ["", "ab", "x".repeat(1001)]) expect(await succeeded(await post(request, "sendBackAction", { ...f, note }, { cookie: token, origin: ORIGIN })), note.length.toString()).toBe(false);
    expect(await succeeded(await post(request, "sendBackAction", { ...f, seenHash: "0".repeat(64), note: "make it shorter" }, { cookie: token, origin: ORIGIN }))).toBe(false);
    expect(await approvals(videoId)).toBe(0);
    expect(await succeeded(await post(request, "sendBackAction", { ...f, note: "make it shorter" }, { cookie: token, origin: ORIGIN }))).toBe(true);
    expect(await count("select count(*)::int as n from approvals where video_id = $1 and decision = 'sent_back' and note = 'make it shorter'", [videoId])).toBe(1);
    expect(await count("select count(*)::int as n from stage_runs where video_id = $1 and name = 'draft' and status = 'queued'", [videoId])).toBe(1);
  });
});

test.describe("publish", () => {
  test("a session approves exactly the rendered publish once; a stale hash, no session and no Origin do nothing", async ({ request }) => {
    const { videoId } = await seedPublishGate(`publish-${stamp()}`);
    const f = await liveFields(videoId, "publish");
    const token = await mintSession();
    const uploads = () => count("select count(*)::int as n from uploads where video_id = $1", [videoId]);
    expect(await succeeded(await post(request, "approveGateAction", f, { origin: ORIGIN }))).toBe(false);
    expect(await succeeded(await post(request, "approveGateAction", f, { cookie: token }))).toBe(false);
    expect(await succeeded(await post(request, "approveGateAction", { ...f, seenHash: "0".repeat(64) }, { cookie: token, origin: ORIGIN }))).toBe(false);
    expect(await uploads()).toBe(0);
    expect(await succeeded(await post(request, "approveGateAction", f, { cookie: token, origin: ORIGIN }))).toBe(true);
    expect(await uploads()).toBe(1);
    expect(await succeeded(await post(request, "approveGateAction", f, { cookie: token, origin: ORIGIN }))).toBe(false);
    expect(await uploads()).toBe(1);
  });

  test("changing the title after the page was rendered voids that page's approval", async ({ request }) => {
    const { videoId } = await seedPublishGate(`publish-stale-${stamp()}`);
    const f = await liveFields(videoId, "publish");
    await db().query(
      "insert into video_content (video_id, kind, version, sha256, body) select $1, 'metadata', max(version) + 1, $2, $3::jsonb from video_content where video_id = $1 and kind = 'metadata'",
      [videoId, "a".repeat(64), JSON.stringify({ title: "Changed", visibility: "unlisted", publish_at: null })],
    );
    const token = await mintSession();
    expect(await succeeded(await post(request, "approveGateAction", f, { cookie: token, origin: ORIGIN }))).toBe(false);
    expect(await count("select count(*)::int as n from uploads where video_id = $1", [videoId])).toBe(0);
  });
});

test.describe("parked stages, breaker, uploads, cancel, dry run", () => {
  test("resolving a parked step needs a session, the dollar figure the page showed and the billing check", async ({ request }) => {
    const { stageId, videoId } = await seedParked(`parked-${stamp()}`);
    const token = await mintSession();
    const base = { stageRunId: stageId, choice: "release_and_rerun", seenMaxMicroUsd: "250000", seenReason: "paid_call_may_have_run", checked: "on" };
    const status = () => db().query("select status from stage_runs where id = $1", [stageId]).then((r) => r.rows[0].status as string);
    expect(await succeeded(await post(request, "resolveDecisionAction", base, { origin: ORIGIN }))).toBe(false);
    expect(await succeeded(await post(request, "resolveDecisionAction", base, { cookie: token }))).toBe(false);
    expect(await succeeded(await post(request, "resolveDecisionAction", { ...base, seenMaxMicroUsd: "1" }, { cookie: token, origin: ORIGIN }))).toBe(false);
    expect(await succeeded(await post(request, "resolveDecisionAction", { ...base, checked: "" }, { cookie: token, origin: ORIGIN }))).toBe(false);
    expect(await succeeded(await post(request, "resolveDecisionAction", { ...base, choice: "raise_cap_and_rerun" }, { cookie: token, origin: ORIGIN }))).toBe(false);
    expect(await status()).toBe("needs_decision");
    expect(await succeeded(await post(request, "resolveDecisionAction", base, { cookie: token, origin: ORIGIN }))).toBe(true);
    expect(await status()).not.toBe("needs_decision");
    expect(await count("select count(*)::int as n from stage_runs where video_id = $1 and name = 'draft'", [videoId])).toBe(2);
  });

  test("cancel video: no session changes nothing, a session cancels", async ({ request }) => {
    const { videoId } = await seedScriptGate(`cancel-${stamp()}`);
    const token = await mintSession();
    const state = () => db().query("select status from videos where id = $1", [videoId]).then((r) => r.rows[0].status as string);
    expect(await succeeded(await post(request, "cancelVideoAction", { videoId }, { origin: ORIGIN }))).toBe(false);
    expect(await succeeded(await post(request, "cancelVideoAction", { videoId }, { cookie: token }))).toBe(false);
    expect(await state()).not.toBe("cancelled");
    expect(await succeeded(await post(request, "cancelVideoAction", { videoId }, { cookie: token, origin: ORIGIN }))).toBe(true);
    expect(await state()).toBe("cancelled");
  });

  test("breaker reset and upload requeue need a session and valid input", async ({ request }) => {
    const token = await mintSession();
    const reset = (o: { cookie?: string; origin?: string }, stage = "draft") => post(request, "resetBreakerAction", { stage }, o);
    expect(await succeeded(await reset({ origin: ORIGIN }))).toBe(false);
    expect(await succeeded(await reset({ cookie: token }))).toBe(false);
    expect(await succeeded(await reset({ cookie: token, origin: ORIGIN }, "qa"))).toBe(false); // no breaker on that step
    expect(await succeeded(await reset({ cookie: token, origin: ORIGIN }))).toBe(true);
    const requeue = (o: { cookie?: string; origin?: string }, uploadId: string) => post(request, "requeueUploadAction", { uploadId }, o);
    const id = "11111111-1111-4111-8111-111111111111";
    expect(await succeeded(await requeue({ origin: ORIGIN }, id))).toBe(false);
    expect(await succeeded(await requeue({ cookie: token, origin: ORIGIN }, id))).toBe(false); // no such upload
    expect(await succeeded(await requeue({ cookie: token, origin: ORIGIN }, "not-a-uuid"))).toBe(false);
  });

  test("the dry run does not exist in a production build without ENGINE_DRY_RUN: 404, no video made", async ({ request }) => {
    const token = await mintSession();
    const before = await count("select count(*)::int as n from videos where notes = 'dry run'");
    const withSession = await post(request, "startDryRunAction", {}, { cookie: token, origin: ORIGIN });
    expect(await succeeded(withSession)).toBe(false);
    expect(withSession.status()).toBe(404);
    const anon = await post(request, "startDryRunAction", {}, { origin: ORIGIN });
    expect(await succeeded(anon)).toBe(false);
    expect(await count("select count(*)::int as n from videos where notes = 'dry run'")).toBe(before);
  });
});
