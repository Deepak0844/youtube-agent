import { describe, expect, it } from "vitest";
import { catalogResolver, chainResolvers, fileResolver, isSafeModelFile, modelKey, SCENE3D_DEMO, validateScene3d } from "../../src/shared/scene3d";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const clone = (): any => structuredClone(SCENE3D_DEMO);
const errorsOf = (v: unknown, r?: Parameters<typeof validateScene3d>[1]): string[] => {
  const res = validateScene3d(v, r);
  return res.ok ? [] : res.errors;
};

describe("scene format v2 validator", () => {
  it("accepts the demo scene and totals its shots", () => {
    const r = validateScene3d(SCENE3D_DEMO);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.totalS).toBe(10);
  });

  it("rejects a video longer than 60 s with a plain sentence", () => {
    const s = clone();
    s.shots = Array.from({ length: 4 }, (_, i) => ({ id: `s${i}`, duration_s: 20, focus: "city" }));
    expect(errorsOf(s).join(" ")).toContain("at most 60 s");
  });

  it("rejects unknown element kinds and unknown fields", () => {
    const s = clone();
    s.elements.push({ kind: "dragon", id: "d1" });
    expect(errorsOf(s).length).toBeGreaterThan(0);
    const t = clone();
    t.elements[0].colour = "red";
    expect(errorsOf(t).length).toBeGreaterThan(0);
  });

  it("rejects out-of-range placement and bad colours", () => {
    const s = clone();
    s.elements[0].at = { x: 99999, z: 0 };
    expect(errorsOf(s).join(" ")).toContain("elements.0.at.x");
    const t = clone();
    t.elements.find((e: { kind: string }) => e.kind === "sand_pile").color = "yellow";
    expect(errorsOf(t).join(" ")).toContain("colour like #aa8844");
  });

  it("rejects shots that point at nothing", () => {
    const s = clone();
    s.shots[0].focus = "nope";
    expect(errorsOf(s).join(" ")).toContain('"nope", which is not in the element list');
    const t = clone();
    delete t.shots[0].focus;
    expect(errorsOf(t).join(" ")).toContain("neither a focus element nor a free camera");
  });

  it("rejects duplicate ids, a pour on a non-pile and animations that outlive the video", () => {
    const s = clone();
    s.elements.push({ ...s.elements[0] });
    expect(errorsOf(s).join(" ")).toContain("share the id");
    const t = clone();
    t.elements.find((e: { id: string }) => e.id === "barge").animations.push({ type: "pour", from: [0, 1, 0], start_s: 0, duration_s: 1 });
    expect(errorsOf(t).join(" ")).toContain("only a sand_pile can be built by a pour");
    const u = clone();
    u.elements.find((e: { id: string }) => e.id === "mound").animations[0].duration_s = 30;
    expect(errorsOf(u).join(" ")).toContain("after the video ends");
  });

  it("checks model references against a resolver", () => {
    const s = clone();
    expect(errorsOf(s, fileResolver())).toEqual([]);
    s.elements.find((e: { id: string }) => e.id === "house").model = { catalog: "house-01" };
    expect(errorsOf(s, fileResolver()).join(" ")).toContain('"house-01" is not in the catalogue');
    expect(errorsOf(s, catalogResolver({ "house-01": "x.glb" }))).toEqual([]);
  });
});

describe("ModelResolver", () => {
  it("only lets .glb files under assets3d/files/ or models/ through", () => {
    expect(isSafeModelFile("assets3d/files/house.glb")).toBe(true);
    expect(isSafeModelFile("models/a/b.glb")).toBe(true);
    for (const bad of ["../x.glb", "assets3d/files/../../etc/x.glb", "/etc/x.glb", "assets3d/files/x.png", "models//x.glb", "other/x.glb"]) expect(isSafeModelFile(bad)).toBe(false);
  });

  it("maps files and catalogue ids, and chains resolvers in order", () => {
    const f = fileResolver((p) => `/public/${p}`);
    expect(f.resolve({ file: "models/a.glb" })).toEqual({ url: "/public/models/a.glb" });
    expect(f.resolve({ file: "../a.glb" })).toBeNull();
    expect(f.resolve({ catalog: "a" })).toBeNull();
    const c = catalogResolver({ tree: "t.glb" });
    expect(c.resolve({ catalog: "tree" })).toEqual({ url: "t.glb" });
    expect(c.resolve({ catalog: "constructor" })).toBeNull();
    const both = chainResolvers(c, f);
    expect(both.resolve({ catalog: "tree" })?.url).toBe("t.glb");
    expect(both.resolve({ file: "models/a.glb" })?.url).toBe("/public/models/a.glb");
    expect(modelKey({ catalog: "tree" })).toBe("catalog:tree");
    expect(modelKey({ file: "models/a.glb" })).toBe("file:models/a.glb");
  });
});
