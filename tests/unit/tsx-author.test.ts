import { describe, expect, it } from "vitest";
import type { Message } from "@/server/core/agent-loop";
import { KnownFailure, NeedsDecisionError } from "@/server/core/paid-call";
import { GOOD_SCENE } from "../fixtures/tsx-good-scene";
import { authorTsx, TSX_MAX_ATTEMPTS, type AuthorDeps } from "@/server/core/tsx-author";
import type { TsxRenderResult } from "@/server/providers/renderer/tsx-render";

// narration 8.6 s -> ceil(9 * 30) = 270 frames, the example's length
const TASK = { topic: "t", beats: [{ id: "b1", text: "hello there", visual: "bars" }], words: [], narrationS: 8.6 };
const GOOD = GOOD_SCENE;
const reply = (src: string) => "```tsx\n" + src + "\n```";
const OK: TsxRenderResult = { ok: true, outPath: "/x/render.mp4", image: "img", stills: [] };
const fail = (kind: "check" | "typecheck" | "render" | "timeout" | "preflight" | "output" | "review" | "infra", message = "m", problems: string[] = []): TsxRenderResult => ({ ok: false, error: { kind, message, problems } });

function run(replies: string[], renders: TsxRenderResult[]) {
  const asked: Message[][] = [];
  const logs: string[] = [];
  const sources: string[] = [];
  const deps: AuthorDeps = {
    ask: async (m) => {
      asked.push(m);
      const r = replies[asked.length - 1];
      if (r === undefined) throw new Error("model asked too often");
      return r;
    },
    render: async (s) => {
      sources.push(s);
      return renders[sources.length - 1]!;
    },
    log: (l) => logs.push(l),
  };
  return { deps, asked, logs, sources };
}

describe("authorTsx", () => {
  it("success on the first attempt: one ask, one render, nothing fed back", async () => {
    const t = run([reply(GOOD)], [OK]);
    const out = await authorTsx(t.deps, TASK);
    expect(out).toMatchObject({ ok: true, attempts: 1, durationInFrames: 270, outPath: "/x/render.mp4", image: "img" });
    expect(t.asked).toHaveLength(1);
    expect(t.asked[0]!.map((m) => m.role)).toEqual(["system", "user"]);
  });

  it("a typed render failure is fed back (problem list plus the previous file) and the second answer is accepted", async () => {
    const t = run([reply(GOOD), reply(GOOD + "\n// fixed\n")], [fail("preflight", "The preview frames show a problem.", ["Frame 0 is black."]), OK]);
    const out = await authorTsx(t.deps, TASK);
    expect(out).toMatchObject({ ok: true, attempts: 2 });
    const retry = t.asked[1]!;
    expect(retry.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(retry[2]!.content).toContain("export const meta");
    expect(retry[3]!.content).toContain("BEGIN_DATA problems");
    expect(retry[3]!.content).toContain("Frame 0 is black.");
    expect(retry[3]!.content).toContain("preview frames");
  });

  it("static-check problems are fed back without spending a render", async () => {
    const bad = GOOD.replace("useCurrentFrame();", "useCurrentFrame(); const t = Date.now();");
    const t = run([reply(bad), reply(GOOD)], [OK]);
    const out = await authorTsx(t.deps, TASK);
    expect(out).toMatchObject({ ok: true, attempts: 2 });
    expect(t.sources).toEqual([GOOD]); // the bad file never reached the renderer
    expect(t.asked[1]![3]!.content).toMatch(/safety check refused/);
    expect(t.asked[1]![3]!.content).toMatch(/line \d+: /);
  });

  it("slack is one-sided: up to 15 frames longer is fine, at most 3 frames shorter", async () => {
    const at = (n: number) => GOOD.replace("durationInFrames: 270", `durationInFrames: ${n}`);
    for (const [n, ok] of [[285, true], [286, false], [267, true], [266, false]] as const) {
      const t = run([reply(at(n)), reply(at(n))], [OK, OK]);
      expect((await authorTsx(t.deps, TASK, 1)).ok, String(n)).toBe(ok);
    }
  });
  it("a wrong length is a timing problem with the exact number", async () => {
    const wrong = GOOD.replace("durationInFrames: 270", "durationInFrames: 90");
    const t = run([reply(wrong), reply(GOOD)], [OK]);
    expect(await authorTsx(t.deps, TASK)).toMatchObject({ ok: true, attempts: 2 });
    expect(t.asked[1]![3]!.content).toContain("durationInFrames must be 270");
  });

  it("a reply with no code block is a format problem and the bad reply is not echoed back", async () => {
    const t = run(["sorry, no code", reply(GOOD)], [OK]);
    expect(await authorTsx(t.deps, TASK)).toMatchObject({ ok: true, attempts: 2 });
    expect(t.asked[1]!.map((m) => m.role)).toEqual(["system", "user", "user"]);
  });

  it("stops after the cap of three attempts with different problems, and reports the last step", async () => {
    const t = run([reply(GOOD), reply(GOOD + "//a\n"), reply(GOOD + "//b\n")], [fail("typecheck", "type", ["line 1: a"]), fail("render", "render", ["x"]), fail("timeout", "slow")]);
    const out = await authorTsx(t.deps, TASK);
    expect(out).toMatchObject({ ok: false, attempts: TSX_MAX_ATTEMPTS, why: "cap", step: "timeout" });
    expect(t.asked).toHaveLength(3);
  });

  it("stops early when the same problems come back twice in a row", async () => {
    const t = run([reply(GOOD), reply(GOOD + "//a\n")], [fail("render", "The TSX render failed (exit 1).", ["boom"]), fail("render", "The TSX render failed (exit 1).", ["boom"])]);
    const out = await authorTsx(t.deps, TASK);
    expect(out).toMatchObject({ ok: false, attempts: 2, why: "repeat", step: "render" });
    expect(t.asked).toHaveLength(2);
  });

  it("an infrastructure failure is not the model's fault: it throws a known failure and asks for no retry", async () => {
    const t = run([reply(GOOD)], [fail("infra", "The TSX render folders could not be prepared (x).")]);
    await expect(authorTsx(t.deps, TASK)).rejects.toBeInstanceOf(KnownFailure);
    expect(t.asked).toHaveLength(1);
  });

  it("a paid-call error (budget refused, unclear outcome) goes up untouched and is never retried", async () => {
    const err = new NeedsDecisionError("run", "key", 1000);
    const deps: AuthorDeps = { ask: async () => { throw err; }, render: async () => OK, log: () => undefined };
    await expect(authorTsx(deps, TASK)).rejects.toBe(err);
  });

  it("the attempt cap cannot be raised above three", async () => {
    const t = run([reply(GOOD), reply(GOOD + "//1\n"), reply(GOOD + "//2\n"), reply(GOOD + "//3\n")], [fail("render", "a"), fail("render", "b"), fail("render", "c"), OK]);
    expect(await authorTsx(t.deps, TASK, 99)).toMatchObject({ ok: false, attempts: 3 });
    const one = run([reply(GOOD)], [fail("render", "a")]);
    expect(await authorTsx(one.deps, TASK, 1)).toMatchObject({ ok: false, attempts: 1, why: "cap" });
  });

  it("logs never echo more than 30 characters of the source or of a problem", async () => {
    const secretLine = "const SUPER_SECRET_MARKER_VALUE_THAT_IS_LONG = 1;";
    const bad = GOOD.replace("useCurrentFrame();", `useCurrentFrame(); ${secretLine} const x = window;`);
    const t = run([reply(bad), reply(GOOD)], [OK]);
    await authorTsx(t.deps, TASK);
    for (const l of t.logs) expect(l).not.toContain("SUPER_SECRET_MARKER_VALUE_THAT");
    expect(t.logs.some((l) => /attempt 1 of 3 failed at check/.test(l))).toBe(true);
  });
});

describe("authorTsx frame review", () => {
  const SHOTS = [{ frame: 0, jpeg: new Uint8Array([1]) }];
  const BAD = { status: "done" as const, ok: false, frames: [{ frame: 0, showsWhatIsSaid: false, problems: ["object too small" as const], fix: "Make it bigger" }] };
  const GOODV = { status: "done" as const, ok: true, frames: [{ frame: 0, showsWhatIsSaid: true, problems: [], fix: "" }] };
  /** A renderer that, like renderTsx, calls the review hook with shots and stops with a 'review' failure when it returns problems. */
  function reviewed(replies: string[], verdicts: Array<typeof BAD | typeof GOODV | { status: "unavailable"; reason: string }>) {
    const t = run(replies, []);
    let reviews = 0;
    t.deps.review = async () => verdicts[reviews++]!;
    t.deps.render = async (s, hook) => {
      t.sources.push(s);
      const found = hook ? await hook(SHOTS) : null;
      return found && found.length > 0 ? fail("review", "A reviewer found problems.", found) : OK;
    };
    return { t, reviews: () => reviews };
  }

  it("a not-ok review with attempts left goes back to the author as a problem list and counts as an attempt", async () => {
    const { t } = reviewed([reply(GOOD), reply(GOOD + "\n// better\n")], [BAD, GOODV]);
    const out = await authorTsx(t.deps, TASK);
    expect(out).toMatchObject({ ok: true, attempts: 2, review: { status: "done", ok: true } });
    expect(t.asked[1]![3]!.content).toContain("frame 0: does not show what is said, object too small. Fix: Make it bigger");
    expect(t.asked[1]![3]!.content).toContain("key frames");
  });

  it("the same review problem twice does not stop early, and on the last attempt the render is accepted with the bad verdict", async () => {
    const { t } = reviewed([reply(GOOD), reply(GOOD), reply(GOOD)], [BAD, BAD, BAD]);
    const out = await authorTsx(t.deps, TASK);
    expect(out).toMatchObject({ ok: true, attempts: TSX_MAX_ATTEMPTS, review: { status: "done", ok: false } });
  });

  it("review-reject, review-reject, then a check failure: the best rejected file is rendered without a review, not dropped to the scene kit", async () => {
    const BADFILE = GOOD.replace("useCurrentFrame();", "useCurrentFrame(); const t = Date.now();");
    const { t } = reviewed([reply(GOOD), reply(GOOD + "\n// b\n"), reply(BADFILE)], [BAD, BAD]);
    const out = await authorTsx(t.deps, TASK);
    expect(out).toMatchObject({ ok: true, attempts: 3, review: { status: "done", ok: false } });
    expect(t.sources).toEqual([GOOD, GOOD + "\n// b\n", GOOD + "\n// b\n"]); // the last render had no review hook
    expect(t.logs.some((l) => /using attempt 2, reviewer concerns remain/.test(l))).toBe(true);
  });

  it("if that salvage render also fails, the author falls back as before (with the verdict attached)", async () => {
    const BADFILE = GOOD.replace("useCurrentFrame();", "useCurrentFrame(); const t = Date.now();");
    const { t } = reviewed([reply(GOOD), reply(GOOD + "\n// b\n"), reply(BADFILE)], [BAD, BAD]);
    const base = t.deps.render;
    let n = 0;
    t.deps.render = async (s, h) => (++n === 3 ? fail("render", "boom") : base(s, h));
    const out = await authorTsx(t.deps, TASK);
    expect(out).toMatchObject({ ok: false, why: "cap", review: { status: "done", ok: false } });
  });

  it("an unavailable review never blocks or retries", async () => {
    const { t } = reviewed([reply(GOOD)], [{ status: "unavailable", reason: "frame review unavailable: the answer was not valid JSON" }]);
    const out = await authorTsx(t.deps, TASK);
    expect(out).toMatchObject({ ok: true, attempts: 1, review: { status: "unavailable" } });
    expect(t.asked).toHaveLength(1);
  });

  it("an unclear paid outcome in the review goes up untouched", async () => {
    const { t } = reviewed([reply(GOOD)], []);
    t.deps.review = async () => {
      throw new NeedsDecisionError("run", "k", 5);
    };
    await expect(authorTsx(t.deps, TASK)).rejects.toBeInstanceOf(NeedsDecisionError);
  });
});
