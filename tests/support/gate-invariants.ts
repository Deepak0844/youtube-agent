import { expect } from "vitest";
import { GATE_ROADMAP_PHASE, type Gate, type GateId } from "@/server/core/gates";

// Shared checks for every human gate (Doc 02 4.4, 5). A phase that implements a gate writes ONE `act` function that
// drives its real approval path, then runs the four helpers below against it. The helpers fail closed: a refusal
// must be an explicit `{ ok: false, reason }`; a thrown error or a refusal without a reason fails the test, so an
// infrastructure fault can never be mistaken for "the gate said no".
//
// Hash choices, resolved by `act`:
//   "seen"    the hash of the content as it was when the owner looked at the page (snapshotted when the test starts)
//   "current" the hash of the content right now (equals "seen" until something mutates it)
//   "stale"   a hash that never matched anything
export type GateActor = "session" | "token" | "system" | "job" | "anonymous";
export type HashChoice = "seen" | "current" | "stale";
export interface GateAttempt {
  actor: GateActor;
  hash: HashChoice;
}
export interface GateResult {
  ok: boolean;
  reason?: string;
}
export type GateAct = (attempt: GateAttempt) => Promise<GateResult>;

const NON_SESSION: GateActor[] = ["token", "system", "job", "anonymous"];

async function refused(gate: Gate, act: GateAct, attempt: GateAttempt): Promise<void> {
  const r = await act(attempt);
  expect(r.ok, `${gate.id}: ${attempt.actor}/${attempt.hash} must be refused`).toBe(false);
  expect(r.reason?.trim(), `${gate.id}: a refusal must say why`).toBeTruthy();
}
async function accepted(gate: Gate, act: GateAct, attempt: GateAttempt): Promise<void> {
  const r = await act(attempt);
  expect(r.ok, `${gate.id}: control ${attempt.actor}/${attempt.hash} must be accepted (otherwise the refusals above prove nothing): ${r.reason ?? ""}`).toBe(true);
}

/** Nobody but a session can approve, whatever hash they bring; the session with the right hash still can (control). */
export async function expectSessionRequired(gate: Gate, act: GateAct): Promise<void> {
  for (const actor of NON_SESSION) for (const hash of ["seen", "current"] as const) await refused(gate, act, { actor, hash });
  await accepted(gate, act, { actor: "session", hash: "current" });
}

/** An API token cannot pass the gate, even with the correct hash. */
export async function expectTokenCannotPass(gate: Gate, act: GateAct): Promise<void> {
  await refused(gate, act, { actor: "token", hash: "seen" });
  await refused(gate, act, { actor: "token", hash: "current" });
  await accepted(gate, act, { actor: "session", hash: "current" });
}

/** A hash that does not match the content is rejected; the matching hash is accepted (control). */
export async function expectStaleHashRejected(gate: Gate, act: GateAct): Promise<void> {
  await refused(gate, act, { actor: "session", hash: "stale" });
  await accepted(gate, act, { actor: "session", hash: "current" });
}

/** After `mutate()` changes the covered content, the hash the owner saw is refused; re-reviewing (current hash) works. */
export async function expectApprovalVoidedByChange(gate: Gate, mutate: () => Promise<void>, act: GateAct): Promise<void> {
  await mutate();
  await refused(gate, act, { actor: "session", hash: "seen" });
  await accepted(gate, act, { actor: "session", hash: "current" });
}

// ---- registry --------------------------------------------------------------------------------------------------------
export type GateSuite = { suite: string } | { todoPhase: number };

/**
 * Where each gate's action tests live. A phase that implements a gate replaces its `todoPhase` with `{ suite: "<path>" }`
 * (a real file that runs the four helpers above and mentions the gate id). A new gate id in GATES with no entry here fails
 * tests/unit/gates.test.ts (and the Record type breaks `tsc`).
 */
export const GATE_SUITES: Record<GateId, GateSuite> = {
  outline: { todoPhase: GATE_ROADMAP_PHASE.outline },
  script: { todoPhase: GATE_ROADMAP_PHASE.script },
  cost: { todoPhase: GATE_ROADMAP_PHASE.cost },
  chapter: { todoPhase: GATE_ROADMAP_PHASE.chapter },
  video: { todoPhase: GATE_ROADMAP_PHASE.video },
  thumbnail: { todoPhase: GATE_ROADMAP_PHASE.thumbnail },
  evidence: { todoPhase: GATE_ROADMAP_PHASE.evidence },
  publish: { todoPhase: GATE_ROADMAP_PHASE.publish },
  comment_reply: { todoPhase: GATE_ROADMAP_PHASE.comment_reply },
  allow_public: { suite: "tests/unit/safety-settings-session-only.test.ts" }, // the flag is the safety setting policy.allow_public
  live_title: { todoPhase: GATE_ROADMAP_PHASE.live_title },
};

/** What a registered suite file must contain: the harness import, a helper call, a describe, and the gate id as a string. */
export function suiteProblems(id: string, src: string): string[] {
  const out: string[] = [];
  if (!/from\s+["'][^"']*support\/gate-invariants["']/.test(src)) out.push("does not import tests/support/gate-invariants");
  if (!/\bexpect(?:SessionRequired|TokenCannotPass|StaleHashRejected|ApprovalVoidedByChange)\s*\(/.test(src)) out.push("never calls a gate-invariants helper");
  if (!/\bdescribe\s*[(.]/.test(src)) out.push("has no describe block");
  if (!new RegExp(`["'\`]${id}["'\`]`).test(src)) out.push(`never names the gate "${id}" as a string`);
  return out;
}

/** Ids of gates that have neither a suite path nor a numeric todoPhase. */
export function gatesWithoutSuite(gates: readonly Gate[], suites: Record<string, GateSuite | undefined>): string[] {
  return gates
    .filter((g) => {
      const s = suites[g.id];
      return !s || !(("suite" in s && typeof s.suite === "string" && s.suite.length > 0) || ("todoPhase" in s && Number.isInteger(s.todoPhase)));
    })
    .map((g) => g.id);
}
