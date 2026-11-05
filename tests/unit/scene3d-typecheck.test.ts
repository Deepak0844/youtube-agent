import { describe, expect, it } from "vitest";
import { S3K_EXAMPLE_A, S3K_EXAMPLE_B } from "@/server/core/s3k-kit-dts";
import { typeCheckScene3d } from "@/server/render/scene3d-typecheck";

// The real TypeScript compiler, in-process, against the kit's api.d.ts and the app's installed three, react, remotion and fiber typings.
describe("typeCheckScene3d", () => {
  it("passes both authoring examples", () => {
    expect(typeCheckScene3d(S3K_EXAMPLE_A)).toMatchObject({ ok: true, problems: [] });
    expect(typeCheckScene3d(S3K_EXAMPLE_B)).toMatchObject({ ok: true, problems: [] });
  }, 60_000);

  it("names a wrong kit import and offers the closest allowed names", () => {
    const r = typeCheckScene3d(`import { Wrold } from "s3k";\nexport default function S() { return null; }\n`);
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toMatch(/line 1: import: s3k has no "Wrold"; the closest allowed names are World/);
  }, 60_000);

  it("names a wrong three import and an unknown name, and types props and JSX", () => {
    const bad = `import { Mesh, Boxgeometry } from "three";
import { World } from "s3k";
import type { SceneProps } from "s3k";
export default function S(p: SceneProps) {
  const n: string = p.durationS;
  const e = process.env.X;
  return <World focus={{ min: [0, 0, 0] }}>{String(Mesh)}{String(Boxgeometry)}{e}{n}</World>;
}
`;
    const r = typeCheckScene3d(bad);
    expect(r.ok).toBe(false);
    const text = r.problems.join("\n");
    expect(text).toMatch(/import: three has no "Boxgeometry"; the closest allowed names are BoxGeometry/);
    expect(text).toMatch(/line 5: type error: .*not assignable/);
    expect(text).toMatch(/line 6: name: "process" is not defined/);
    expect(text).toMatch(/line 7: type error/);
    for (const p of r.problems) expect(p.length).toBeLessThanOrEqual(260);
  }, 60_000);

  it("resolves only the allowed modules and knows three.js elements without importing fiber", () => {
    const r = typeCheckScene3d(`import fs from "fs";\nexport default function S() { return <mesh><boxGeometry args={[1, 1, 1]} /></mesh>; }\n`);
    expect(r.problems.join("\n")).toMatch(/line 1: import: the module "fs" is not available/);
    expect(r.problems.join("\n")).not.toMatch(/mesh|boxGeometry/);
  }, 60_000);

  it("stops at its time budget and fails closed", () => {
    const r = typeCheckScene3d(S3K_EXAMPLE_A, 1);
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatch(/took longer than/);
  }, 60_000);
});
