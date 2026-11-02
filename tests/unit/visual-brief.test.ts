import { describe, expect, it } from "vitest";
import { validateScript, beatSchema } from "@/server/core/script-contract";
import { fillMessages, pickMessages } from "@/server/core/scene-build";
import { checkSceneRules } from "@/shared/scene/rules";

const objs = (...o: object[]) => ({ version: 1, scenes: [{ id: "s1", beat: "hook", kind: "drawn_objects", startMs: 0, durationMs: 3000, objects: o }] }) as never;
const run = (d: unknown, visual?: string) => checkSceneRules(d as never, { only: "icon-label-honest", visual });

describe("beat visual brief", () => {
  it("accepts old and new beats", () => {
    expect(beatSchema.safeParse({ id: "a", text: "t" }).success).toBe(true);
    expect(beatSchema.safeParse({ id: "a", text: "t", visual: "a piston in a cylinder", search: ["petrol engine cutaway"] }).success).toBe(true);
    expect(beatSchema.safeParse({ id: "a", search: "x" }).success).toBe(false);
  });
  it("a script with old beats still validates", () => {
    const r = validateScript({ narration: "hi", beats: [{ id: "hook", text: "hi" }], title: "T", evidence: [] }, "en", "long", { requireEvidence: false });
    expect(r.ok).toBe(true);
  });
});

describe("icon-label-honest", () => {
  it("fails a label the icon is not, with the plain message", () => {
    expect(run(objs({ object: "container", label: "Piston" }))[0]).toContain('Label "Piston" does not describe a container icon');
  });
  it("passes allowed words, digits, units, no label", () => {
    expect(run(objs({ object: "container", label: "Tank" }, { object: "jug", label: "Bottle" }, { object: "ruler", label: "12 cm" }, { object: "cloud" }))).toEqual([]);
  });
  it("judges an assembled doc with each beat's own brief (same exception the beat got when built)", () => {
    const doc = objs({ object: "server_rack", label: "Health Check" });
    const only = (visualByBeat?: Record<string, string>) => checkSceneRules(doc, { only: "icon-label-honest", visualByBeat });
    expect(only()[0]).toContain('Label "Health Check" does not describe a server rack icon');
    expect(only({ hook: "a server rack with a health check light" })).toEqual([]);
    expect(only({ other: "a server rack" })[0]).toContain("Health Check"); // another beat's brief does not excuse this scene
  });
  it("skips non-Latin script labels", () => {
    expect(run(objs({ object: "container", label: "சிலிண்டர்" }))).toEqual([]);
  });
  it("allows any label when the brief names that object", () => {
    expect(run(objs({ object: "laptop", label: "Editor" }), "a laptop on a desk")).toEqual([]);
    expect(run(objs({ object: "laptop", label: "Editor" }), "a piston")).toHaveLength(1);
  });
  it("is part of the build check (checkSceneRules default run)", () => {
    expect(checkSceneRules(objs({ object: "jug", label: "Air+Fuel" }))).toHaveLength(1);
  });
});

describe("build prompts", () => {
  const beat = { id: "hook", text: "Engines burn fuel", visual: "cutaway of a petrol engine", search: ["engine cutaway", "piston"] };
  it("pick and fill carry visual and search", () => {
    for (const m of [pickMessages(beat, ["chart", "drawn_objects"]), fillMessages(beat, "chart", [])]) {
      const u = m[1]!.content as string;
      expect(u).toContain("Visual brief: cutaway of a petrol engine");
      expect(u).toContain("Search words: engine cutaway; piston");
    }
    expect(pickMessages(beat, ["chart"])[0]!.content).toMatch(/NEVER use drawn_objects/);
  });
  it("no brief, no extra lines", () => {
    expect(pickMessages({ id: "a", text: "t" }, ["chart"])[1]!.content).toBe("Beat a:\nt");
  });
});
