import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { actionOriginProblem } from "@/lib/auth/origin";
import { checkActionFile } from "../support/route-guards";
import { parseDecisionForm, parseGateForm, parseIdForm, parseStageForm, STALE_MESSAGE, versionsKey } from "@/server/core/queue-input";

const form = (o: Record<string, string>) => ({ get: (k: string) => (k in o ? o[k]! : null) });
const V = "0188a2b4-0000-7000-8000-000000000001";
const H = "a".repeat(64);
const VERS = `script:${V}:3`;

describe("versionsKey", () => {
  it("is stable regardless of key order and names kind, id and version", () => {
    const a = versionsKey({ video: { id: V, version: 2 }, script: { id: V, version: 3 } });
    const b = versionsKey({ script: { id: V, version: 3 }, video: { id: V, version: 2 } });
    expect(a).toBe(b);
    expect(a).toBe(`script:${V}:3,video:${V}:2`);
  });
});

describe("parseGateForm", () => {
  const ok = { videoId: V, gate: "script", seenHash: H, seenVersions: VERS };
  it("accepts the page's fields", () => {
    expect(parseGateForm(form(ok), "approve")).toEqual({ ok: true, value: { videoId: V, gate: "script", seenHash: H, seenVersions: VERS, note: undefined, captionsChecked: false } });
  });
  it("refuses a missing, short or non-hex hash with the stale message", () => {
    for (const seenHash of ["", "abc", "g".repeat(64), H + "0"]) expect(parseGateForm(form({ ...ok, seenHash }), "approve")).toEqual({ ok: false, message: STALE_MESSAGE });
    const rest: Record<string, string> = { ...ok };
    delete rest.seenHash;
    expect(parseGateForm(form(rest), "approve").ok).toBe(false);
  });
  it("refuses missing versions, an unknown gate and a bad video id", () => {
    expect(parseGateForm(form({ ...ok, seenVersions: "" }), "approve").ok).toBe(false);
    expect(parseGateForm(form({ ...ok, gate: "outline" }), "approve").ok).toBe(false);
    expect(parseGateForm(form({ ...ok, videoId: "nope" }), "approve").ok).toBe(false);
  });
  it("send back needs a 3 to 1000 character note; approve ignores any note", () => {
    expect(parseGateForm(form({ ...ok, note: "ab" }), "send_back").ok).toBe(false);
    expect(parseGateForm(form({ ...ok, note: "x".repeat(1001) }), "send_back").ok).toBe(false);
    expect(parseGateForm(form({ ...ok, note: "  make it shorter " }), "send_back")).toMatchObject({ ok: true, value: { note: "make it shorter" } });
    expect(parseGateForm(form({ ...ok, note: "hi" }), "approve")).toMatchObject({ ok: true, value: { note: undefined } });
  });
});

describe("other forms", () => {
  it("decision form needs a known choice, a stage id and the figure the page showed", () => {
    const ok = { stageRunId: V, choice: "release_and_rerun", seenMaxMicroUsd: "250000", seenReason: "paid_call_may_have_run", checked: "on" };
    expect(parseDecisionForm(form(ok))).toMatchObject({ ok: true, value: { choice: "release_and_rerun", seenMaxMicroUsd: 250000, confirmed: true } });
    expect(parseDecisionForm(form({ ...ok, choice: "raise_cap_and_rerun" })).ok).toBe(false); // needs a scope the page cannot name yet
    expect(parseDecisionForm(form({ ...ok, choice: "wipe" })).ok).toBe(false);
    expect(parseDecisionForm(form({ ...ok, seenMaxMicroUsd: "1.5" })).ok).toBe(false);
    expect(parseDecisionForm(form({ ...ok, seenMaxMicroUsd: "-1" })).ok).toBe(false);
    expect(parseDecisionForm(form({ ...ok, checked: "" }))).toMatchObject({ ok: true, value: { confirmed: false } });
  });
  it("id forms and the breaker stage are strict", () => {
    expect(parseIdForm(form({ id: V }), "id")).toEqual({ ok: true, value: V });
    expect(parseIdForm(form({ id: "x" }), "id").ok).toBe(false);
    expect(parseStageForm(form({ stage: "draft" }))).toEqual({ ok: true, value: "draft" });
    expect(parseStageForm(form({ stage: "qa" })).ok).toBe(false);
  });
});

describe("actionOriginProblem", () => {
  const h = (o: Record<string, string>) => new Headers(o);
  it("accepts only an Origin whose host is the Host header", () => {
    expect(actionOriginProblem(h({ host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" }))).toBeNull();
    expect(actionOriginProblem(h({ host: "127.0.0.1:3000", origin: "http://evil.test" }))).not.toBeNull();
    expect(actionOriginProblem(h({ host: "127.0.0.1:3000" }))).not.toBeNull(); // Origin-less is refused
    expect(actionOriginProblem(h({ host: "127.0.0.1:3000", origin: "null" }))).not.toBeNull();
  });
});

describe("the queue action file", () => {
  const src = readFileSync("src/app/(app)/queue/actions.ts", "utf8");
  it("authenticates every action (route-inventory rule) and checks the Origin right after", () => {
    expect(checkActionFile(src)).toEqual([]);
    const bodies = src.split(/export async function /).slice(1);
    expect(bodies.length).toBeGreaterThanOrEqual(6);
    for (const b of bodies) {
      const own = b.indexOf("requireOwner()");
      expect(own, b.slice(0, 40)).toBeGreaterThan(-1);
      expect(b.indexOf("assertActionOrigin()"), b.slice(0, 40)).toBeGreaterThan(own);
    }
  });
  it("takes the session id only from requireOwner()", () => {
    expect(src).not.toMatch(/get\(["']session/i);
    expect(src).not.toMatch(/sessionId:\s*(?!owner\.sessionId)\S/);
  });
});
