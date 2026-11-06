import { describe, expect, it } from "vitest";
import { S3K_EXAMPLE_A, S3K_EXAMPLE_B, S3K_EXAMPLE_C } from "@/server/core/s3k-kit-dts";
import { typeCheckScene3d } from "@/server/render/scene3d-typecheck";

const B = 55_000; // budget for every real check; only the timeout test uses 1 ms
// The real TypeScript compiler in a worker thread, against the kit's api.d.ts and the app's installed three, react, remotion and fiber typings.
describe("typeCheckScene3d", () => {
  it("passes both authoring examples and returns the sha256 of the text it checked", async () => {
    const a = await typeCheckScene3d(S3K_EXAMPLE_A, B);
    expect(a).toMatchObject({ ok: true, problems: [] });
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await typeCheckScene3d(S3K_EXAMPLE_B, B)).toMatchObject({ ok: true, problems: [] });
    expect(await typeCheckScene3d(S3K_EXAMPLE_C, B)).toMatchObject({ ok: true, problems: [] });
  }, 120_000);

  it("reads an array element as the element, not as maybe-undefined (the prompt tells the model to index with arr[i])", async () => {
    const src = `import { World } from "s3k";
const a = [1, 2, 3];
export default function S() {
  let sum = 0;
  for (let i = 0; i < 3; i++) sum += Math.sin(a[i]);
  return <World focus={{ min: [0, 0, 0], max: [1, 1, 1] }} data-sum={sum} />;
}
`;
    const r = await typeCheckScene3d(src, B);
    expect(r.problems.join("\n")).not.toMatch(/undefined/);
  }, 60_000);

  it("names a wrong kit import and offers the closest allowed names", async () => {
    const r = await typeCheckScene3d(`import { Wrold } from "s3k";\nexport default function S() { return null; }\n`, B);
    expect(r.ok).toBe(false);
    expect(r.fatal).toBeUndefined();
    expect(r.problems.join("\n")).toMatch(/line 1: import: s3k has no "Wrold"; the closest allowed names are World/);
  }, 60_000);

  it("names a wrong three import and an unknown name, and types props and JSX", async () => {
    const bad = `import { Mesh, Boxgeometry } from "three";
import { World } from "s3k";
import type { SceneProps } from "s3k";
export default function S(p: SceneProps) {
  const n: string = p.durationS;
  const e = process.env.X;
  return <World focus={{ min: [0, 0, 0] }}>{String(Mesh)}{String(Boxgeometry)}{e}{n}</World>;
}
`;
    const r = await typeCheckScene3d(bad, B);
    expect(r.ok).toBe(false);
    const text = r.problems.join("\n");
    expect(text).toMatch(/import: three has no "Boxgeometry"; the closest allowed names are BoxGeometry/);
    expect(text).toMatch(/line 5: type error: .*not assignable/);
    expect(text).toMatch(/line 6: name: "process" is not defined/);
    expect(text).toMatch(/line 7: type error/);
    for (const p of r.problems) expect(p.length).toBeLessThanOrEqual(260);
  }, 60_000);

  it("resolves only the allowed modules and knows three.js elements without importing fiber", async () => {
    const r = await typeCheckScene3d(`import fs from "fs";\nexport default function S() { return <mesh><boxGeometry args={[1, 1, 1]} /></mesh>; }\n`, B);
    expect(r.problems.join("\n")).toMatch(/line 1: import: the module "fs" is not available/);
    expect(r.problems.join("\n")).not.toMatch(/mesh|boxGeometry/);
  }, 60_000);

  it("sentences carry no absolute path and no import(\"...\") fragment", async () => {
    const r = await typeCheckScene3d(`import { World } from "s3k";\nconst x: import("three").Mesh = 5;\nexport default function S() { return <World focus={{ min: [0, 0, 0], max: [1, 1, 1] }} />; }\n`, B);
    expect(r.ok).toBe(false);
    for (const p of r.problems) expect(p).not.toMatch(/\/Users|\/private|node_modules|import\("/);
  }, 60_000);

  it("a timeout is FATAL (never a hint for the model)", async () => {
    const r = await typeCheckScene3d(S3K_EXAMPLE_A, 1, 1);
    expect(r.ok).toBe(false);
    expect(r.fatal).toBe(true);
    expect(r.problems[0]).toMatch(/took longer than|stopped without|failed/);
  }, 60_000);
});
