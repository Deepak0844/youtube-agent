import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import {
  claimStage,
  commitStage,
  failStage,
  getStage,
  heartbeat,
  insertQueuedStage,
  requestCancel,
} from "@/server/db/stages";
import { uuidv7 } from "@/server/core/ids";
import { withTestDb, type TestDb } from "../support/db";

let db: TestDb;
beforeAll(async () => {
  db = await withTestDb();
});
beforeEach(async () => {
  await db.reset();
});
afterAll(async () => {
  await db?.stop();
});

const TTL = 60_000;

async function queued(inputHash = "h1"): Promise<string> {
  return insertQueuedStage(db.pool, { videoId: uuidv7(), name: "script", inputHash });
}

// Simulates what the reconciler does to a stage whose lease expired: back to queued, owner cleared.
async function requeue(id: string): Promise<void> {
  await db.pool.query(
    "update stage_runs set status='queued', lease_owner=null, lease_until=null, attempt_seq=attempt_seq+1 where id=$1",
    [id],
  );
}

async function expireLease(id: string): Promise<void> {
  await db.pool.query("update stage_runs set lease_until = now() - interval '1 minute' where id=$1", [id]);
}

describe("fenced claim", () => {
  it("only_one_of_twenty_concurrent_claims_wins", async () => {
    // 20 separate connections so the claims really race inside Postgres.
    const pool20 = new pg.Pool({ connectionString: db.pool.options.connectionString, max: 20 });
    try {
      // warm all 20 connections so none of the rounds is serialized by connection setup
      const held = await Promise.all(Array.from({ length: 20 }, () => pool20.connect()));
      held.forEach((c) => c.release());
      for (let round = 0; round < 25; round++) {
        const id = await queued();
        const results = await Promise.all(
          Array.from({ length: 20 }, (_, i) =>
            claimStage(pool20, { id, inputHash: "h1", workerId: `w${i}`, ttlMs: TTL }),
          ),
        );
        const winners = results.filter((r) => r !== null);
        expect(winners).toHaveLength(1);
        const row = await getStage(db.pool, id);
        expect(row?.fence).toBe(1);
        expect(row?.status).toBe("running");
        expect(row?.leaseOwner).toBe(winners[0]!.workerId);
      }
    } finally {
      await pool20.end();
    }
  });

  it("wrong_input_hash_cannot_claim", async () => {
    const id = await queued("h1");
    const before = await getStage(db.pool, id);
    const claim = await claimStage(db.pool, { id, inputHash: "other", workerId: "w", ttlMs: TTL });
    expect(claim).toBeNull();
    const after = await getStage(db.pool, id);
    expect(after).toEqual(before);
    expect(after?.status).toBe("queued");
    expect(after?.fence).toBe(0);
  });

  it("running_succeeded_and_needs_decision_rows_cannot_be_claimed", async () => {
    for (const status of ["running", "succeeded", "needs_decision", "failed", "cancelled"]) {
      const id = await queued();
      await db.pool.query("update stage_runs set status=$2 where id=$1", [id, status]);
      const before = await getStage(db.pool, id);
      const claim = await claimStage(db.pool, { id, inputHash: "h1", workerId: "w", ttlMs: TTL });
      expect(claim, status).toBeNull();
      expect(await getStage(db.pool, id), status).toEqual(before);
    }
  });

  it("claim_on_unknown_id_returns_null", async () => {
    expect(await claimStage(db.pool, { id: uuidv7(), inputHash: "h1", workerId: "w", ttlMs: TTL })).toBeNull();
  });

  it("fence_increases_by_one_per_claim", async () => {
    const id = await queued();
    const c1 = await claimStage(db.pool, { id, inputHash: "h1", workerId: "a", ttlMs: TTL });
    expect(c1?.fence).toBe(1);
    expect(c1?.jobId).toBe(`stage:${id}:1:0`);
    await requeue(id);
    const c2 = await claimStage(db.pool, { id, inputHash: "h1", workerId: "b", ttlMs: TTL });
    expect(c2?.fence).toBe(2);
    expect(c2?.jobId).toBe(`stage:${id}:2:1`);
    await requeue(id);
    const c3 = await claimStage(db.pool, { id, inputHash: "h1", workerId: "c", ttlMs: TTL });
    expect(c3?.fence).toBe(3);
    expect(typeof c3?.fence).toBe("number");
  });

  it("claim_sets_lease_owner_and_future_lease", async () => {
    const id = await queued();
    const claim = await claimStage(db.pool, { id, inputHash: "h1", workerId: "w-1", ttlMs: TTL });
    expect(claim).not.toBeNull();
    expect(claim!.workerId).toBe("w-1");
    expect(claim!.stageRunId).toBe(id);
    const { rows } = await db.pool.query<{ ahead_ms: number }>(
      "select extract(epoch from (lease_until - now())) * 1000 as ahead_ms from stage_runs where id=$1",
      [id],
    );
    expect(Number(rows[0]!.ahead_ms)).toBeGreaterThan(TTL - 5_000);
    expect(Number(rows[0]!.ahead_ms)).toBeLessThanOrEqual(TTL);
    const row = await getStage(db.pool, id);
    expect(row?.status).toBe("running");
    expect(row?.leaseOwner).toBe("w-1");
    expect(row?.leaseUntil?.getTime()).toBe(claim!.leaseUntil.getTime());
  });

  it("heartbeat_extends_lease_for_current_owner", async () => {
    const id = await queued();
    const claim = (await claimStage(db.pool, { id, inputHash: "h1", workerId: "w", ttlMs: 10_000 }))!;
    expect(await heartbeat(db.pool, claim, 120_000)).toBe(true);
    const row = await getStage(db.pool, id);
    expect(row!.leaseUntil!.getTime()).toBeGreaterThan(claim.leaseUntil.getTime() + 60_000);
  });

  it("heartbeat_fails_for_old_fence", async () => {
    const id = await queued();
    const old = (await claimStage(db.pool, { id, inputHash: "h1", workerId: "a", ttlMs: TTL }))!;
    await requeue(id);
    const fresh = (await claimStage(db.pool, { id, inputHash: "h1", workerId: "b", ttlMs: TTL }))!;
    const before = await getStage(db.pool, id);
    expect(await heartbeat(db.pool, old, TTL)).toBe(false);
    expect(await getStage(db.pool, id)).toEqual(before);
    expect(await heartbeat(db.pool, fresh, TTL)).toBe(true);
  });

  it("heartbeat_cannot_revive_an_expired_lease", async () => {
    const id = await queued();
    const claim = (await claimStage(db.pool, { id, inputHash: "h1", workerId: "w", ttlMs: TTL }))!;
    await expireLease(id);
    const before = await getStage(db.pool, id);
    expect(await heartbeat(db.pool, claim, TTL)).toBe(false);
    expect(await getStage(db.pool, id)).toEqual(before);
  });

  it("heartbeat_fails_for_a_different_owner_with_same_fence", async () => {
    const id = await queued();
    const claim = (await claimStage(db.pool, { id, inputHash: "h1", workerId: "a", ttlMs: TTL }))!;
    expect(await heartbeat(db.pool, { ...claim, workerId: "intruder" }, TTL)).toBe(false);
  });

  it("commit_with_stale_fence_is_rejected_and_leaves_row_untouched", async () => {
    const id = await queued();
    const old = (await claimStage(db.pool, { id, inputHash: "h1", workerId: "a", ttlMs: TTL }))!;
    await requeue(id);
    await claimStage(db.pool, { id, inputHash: "h1", workerId: "a", ttlMs: TTL }); // same worker id, fence 2
    const before = await getStage(db.pool, id);
    expect(await commitStage(db.pool, old, { out: "stale" })).toBe(false);
    expect(await getStage(db.pool, id)).toEqual(before);
    expect(before?.status).toBe("running");
    expect(before?.result).toBeNull();
  });

  it("commit_after_lease_taken_by_another_worker_is_rejected", async () => {
    const id = await queued();
    const a = (await claimStage(db.pool, { id, inputHash: "h1", workerId: "a", ttlMs: TTL }))!;
    await expireLease(id);
    await requeue(id);
    const b = (await claimStage(db.pool, { id, inputHash: "h1", workerId: "b", ttlMs: TTL }))!;
    expect(await commitStage(db.pool, a, { from: "a" })).toBe(false);
    expect((await getStage(db.pool, id))?.status).toBe("running");
    expect(await commitStage(db.pool, b, { from: "b" })).toBe(true);
    const row = await getStage(db.pool, id);
    expect(row?.status).toBe("succeeded");
    expect(row?.result).toEqual({ from: "b" });
  });

  it("commit_after_reconciler_requeued_without_reclaim_is_rejected", async () => {
    const id = await queued();
    const a = (await claimStage(db.pool, { id, inputHash: "h1", workerId: "a", ttlMs: TTL }))!;
    await expireLease(id);
    await requeue(id);
    expect(await commitStage(db.pool, a, {})).toBe(false);
    expect((await getStage(db.pool, id))?.status).toBe("queued");
  });

  it("commit_is_not_repeatable", async () => {
    const id = await queued();
    const a = (await claimStage(db.pool, { id, inputHash: "h1", workerId: "a", ttlMs: TTL }))!;
    expect(await commitStage(db.pool, a, { n: 1 })).toBe(true);
    expect(await commitStage(db.pool, a, { n: 2 })).toBe(false);
    expect((await getStage(db.pool, id))?.result).toEqual({ n: 1 });
  });

  // Documents current behaviour: the fence + owner is the gate, the reconciler is what invalidates
  // a lease (by changing status). An expired lease that nobody has requeued yet may still commit.
  it("commit_with_expired_but_not_requeued_lease_still_succeeds", async () => {
    const id = await queued();
    const a = (await claimStage(db.pool, { id, inputHash: "h1", workerId: "a", ttlMs: TTL }))!;
    await expireLease(id);
    expect(await commitStage(db.pool, a, { late: true })).toBe(true);
    expect((await getStage(db.pool, id))?.status).toBe("succeeded");
  });

  it("failStage_requires_current_fence", async () => {
    const id = await queued();
    const old = (await claimStage(db.pool, { id, inputHash: "h1", workerId: "a", ttlMs: TTL }))!;
    await requeue(id);
    const fresh = (await claimStage(db.pool, { id, inputHash: "h1", workerId: "b", ttlMs: TTL }))!;
    const before = await getStage(db.pool, id);
    expect(await failStage(db.pool, old, "boom")).toBe(false);
    expect(await getStage(db.pool, id)).toEqual(before);
    expect(await failStage(db.pool, fresh, "boom")).toBe(true);
    const row = await getStage(db.pool, id);
    expect(row?.status).toBe("failed");
    expect(row?.result).toEqual({ error: "boom" });
  });

  it("requestCancel_sets_flag_only", async () => {
    const id = await queued();
    const claim = (await claimStage(db.pool, { id, inputHash: "h1", workerId: "a", ttlMs: TTL }))!;
    const before = await getStage(db.pool, id);
    await requestCancel(db.pool, id);
    const after = await getStage(db.pool, id);
    expect(after?.cancelRequested).toBe(true);
    expect({ ...after, cancelRequested: false, updatedAt: before!.updatedAt }).toEqual({
      ...before,
      cancelRequested: false,
    });
    expect(after?.status).toBe("running");
    expect(after?.fence).toBe(claim.fence);
    expect(after?.leaseOwner).toBe("a");
  });

  it("getStage_returns_null_for_unknown_id", async () => {
    expect(await getStage(db.pool, uuidv7())).toBeNull();
  });
});
