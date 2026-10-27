import { afterAll, beforeAll, describe, it } from "vitest";
import { gateById } from "@/server/core/gates";
import { withTestDb, type TestDb } from "../../support/db";
import { bumpContent, gateFixture } from "../../support/gate-fixture";
import { expectApprovalVoidedByChange, expectSessionRequired, expectStaleHashRejected, expectTokenCannotPass } from "../../support/gate-invariants";

let db: TestDb;
beforeAll(async () => {
  db = await withTestDb();
});
afterAll(async () => {
  await db?.stop();
});

describe("publish gate", () => {
  const gate = gateById("publish");
  it("only_a_session_can_approve", async () => {
    await expectSessionRequired(gate, (await gateFixture(db.pool, "publish")).act);
  });
  it("a_token_cannot_pass", async () => {
    await expectTokenCannotPass(gate, (await gateFixture(db.pool, "publish")).act);
  });
  it("a_stale_hash_is_rejected", async () => {
    await expectStaleHashRejected(gate, (await gateFixture(db.pool, "publish")).act);
  });
  it("a_change_to_covered_content_voids_the_hash_the_owner_saw", async () => {
    const f = await gateFixture(db.pool, "publish");
    await expectApprovalVoidedByChange(gate, () => bumpContent(db.pool, f.videoId, "metadata"), f.act);
  });
});
