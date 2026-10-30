import { describe, expect, it } from "vitest";
import { describeSceneFormat, sceneJsonSchema, validateScenes } from "@/shared/scene";
import { kinds } from "@/shared/scene/kinds";

const t = { id: "s1", beat: "b1", kind: "terminal", startMs: 0, durationMs: 3000, lines: [{ prompt: "~/app $", text: "npm test" }] };
const c = { id: "s2", beat: "b2", kind: "chat_thread", startMs: 3000, durationMs: 4000, messages: [{ from: "user", text: "hi" }] };
const k = { id: "s3", beat: "b3", kind: "story_kenburns", startMs: 7000, durationMs: 3000, image: "img_ab12", caption: "Hello" };
const doc = (...scenes: unknown[]) => ({ version: 1, scenes });
const errs = (d: unknown) => {
  const r = validateScenes(d);
  return r.ok ? [] : r.errors;
};

describe("scene schema", () => {
  it("accepts all three kinds and fills defaults", () => {
    const r = validateScenes(doc(t, c, k));
    expect(r.ok).toBe(true);
    if (r.ok && r.doc.scenes[2]?.kind === "story_kenburns") expect(r.doc.scenes[2].captionZone).toBe("lower_safe");
  });
  it("rejects unknown kind in plain text", () => {
    expect(errs(doc({ ...t, kind: "hologram" }))[0]).toBe(`scene 1 > kind: must be one of ${Object.keys(kinds).join(", ")}`);
  });
  it("rejects overlong copy with location", () => {
    expect(errs(doc({ ...c, messages: [{ from: "user", text: "x".repeat(91) }] }))).toEqual([
      "scene 1 > messages > 0 > text: must be at most 90 characters",
    ]);
  });
  it("rejects bad timing", () => {
    expect(errs(doc({ ...t, durationMs: 100 }))[0]).toContain("durationMs: must be at least 500 ms");
    expect(errs(doc(t, { ...c, startMs: 1000 }))[0]).toContain("overlaps the previous scene");
    expect(errs(doc({ ...t, startMs: 1.5 })).length).toBe(1);
  });
  it("rejects URLs and paths as asset refs", () => {
    expect(errs(doc({ ...k, image: "https://x.com/a.png" }))[0]).toContain("must be an asset id");
    expect(errs(doc({ ...k, image: "/etc/passwd" }))[0]).toContain("must be an asset id");
  });
  it("rejects wrong version and out-of-safe-area zone", () => {
    expect(errs({ version: 2, scenes: [t] }).length).toBe(1);
    expect(errs(doc({ ...k, captionZone: "middle" })).length).toBe(1);
  });
  it("exposes prompt text and JSON schema", () => {
    expect(describeSceneFormat()).toContain("story_kenburns");
    expect(JSON.stringify(sceneJsonSchema())).toContain("chat_thread");
  });
});

describe("terminal lines", () => {
  const line = (l: unknown) => ({ ...t, lines: [l] });
  it("defaults a missing prompt to $", () => {
    const r = validateScenes(doc(line({ text: "ls" })));
    expect(r.ok).toBe(true);
    if (r.ok && r.doc.scenes[0]?.kind === "terminal") expect(r.doc.scenes[0].lines[0]?.prompt).toBe("$");
  });
  it("treats an empty prompt as $", () => {
    const r = validateScenes(doc(line({ prompt: "", text: "ls" })));
    expect(r.ok).toBe(true);
    if (r.ok && r.doc.scenes[0]?.kind === "terminal") expect(r.doc.scenes[0].lines[0]?.prompt).toBe("$");
  });
  it("allows 56 chars, rejects 57 with the limit in the error", () => {
    expect(errs(doc(line({ text: "x".repeat(56) })))).toEqual([]);
    expect(errs(doc(line({ text: "x".repeat(57) })))).toEqual(["scene 1 > lines > 0 > text: must be at most 56 characters"]);
  });
  it("states the text limit in the prompt text", () => {
    expect(describeSceneFormat()).toContain("max 56 characters per line");
  });
});

describe("drawn_objects and network kinds", () => {
  const d = { id: "s9", beat: "b1", kind: "drawn_objects", startMs: 0, durationMs: 3000, objects: [{ object: "laptop", label: "dev" }] };
  const n = {
    id: "s8",
    beat: "b1",
    kind: "network",
    startMs: 0,
    durationMs: 4000,
    nodes: [
      { id: "me", type: "laptop", label: "Browser" },
      { id: "dns", type: "resolver", label: "Resolver" },
    ],
    links: [{ from: "me", to: "dns", packet: "A?" }],
  };
  it("accepts valid scenes and fills defaults", () => {
    const r = validateScenes(doc(d));
    expect(r.ok).toBe(true);
    if (r.ok && r.doc.scenes[0]?.kind === "drawn_objects") expect(r.doc.scenes[0].objects[0]).toMatchObject({ slot: "center", enter: "fade", emphasis: "none" });
    expect(validateScenes(doc(n)).ok).toBe(true);
  });
  it("bounds drawn objects", () => {
    const o = { object: "cloud" };
    expect(errs(doc({ ...d, objects: [] })).length).toBe(1);
    expect(errs(doc({ ...d, objects: [o, o, o, o, o] }))[0]).toBe("scene 1 > objects: must have at most 4 objects");
    expect(errs(doc({ ...d, objects: [{ object: "dragon" }] })).length).toBe(1);
    expect(errs(doc({ ...d, objects: [{ object: "cloud", label: "x".repeat(21) }] }))[0]).toContain("at most 20");
    expect(errs(doc({ ...d, objects: [{ object: "https://x.io/a.svg" }] })).length).toBe(1);
  });
  it("bounds and checks network", () => {
    const node = (i: number) => ({ id: `n${i}`, type: "rack", label: "x" });
    expect(errs(doc({ ...n, nodes: Array.from({ length: 7 }, (_, i) => node(i)) }))[0]).toBe("scene 1 > nodes: must have at most 6 nodes");
    expect(errs(doc({ ...n, nodes: [node(0)] }))[0]).toContain("at least 2");
    expect(errs(doc({ ...n, links: [{ from: "me", to: "nope" }] }))).toEqual(["scene 1 > links > 0 > to: no node with id 'nope'"]);
    expect(errs(doc({ ...n, links: [{ from: "me", to: "me" }] }))[0]).toContain("must differ");
    expect(errs(doc({ ...n, nodes: [n.nodes[0], n.nodes[0]] }))[0]).toContain("duplicate node id");
    expect(errs(doc({ ...n, links: [{ from: "me", to: "dns", packet: "x".repeat(11) }] }))[0]).toContain("at most 10");
  });
});
