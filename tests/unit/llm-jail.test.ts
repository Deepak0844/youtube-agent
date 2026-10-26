import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createJail } from "@/server/llm/jail";

async function setup() {
  const base = await mkdtemp(path.join(os.tmpdir(), "jail-"));
  const jail = await createJail(path.join(base, "scratch"));
  const t = Object.fromEntries(jail.tools.map((x) => [x.name, x.run])) as Record<"readFile" | "writeFile" | "listDir", (a: unknown) => Promise<string>>;
  return { base, jail, t };
}

describe("jail", () => {
  it("writes_reads_lists_inside", async () => {
    const { t } = await setup();
    await t.writeFile({ path: "a/b.txt", content: "hello" });
    expect(await t.readFile({ path: "a/b.txt" })).toBe("hello");
    expect(await t.listDir({ path: "a" })).toBe("b.txt");
  });
  it.each(["../x", "/etc/passwd", "a/../../x", ""])("rejects_escape_%s", async (p) => {
    const { t } = await setup();
    await expect(t.readFile({ path: p })).rejects.toThrow();
    await expect(t.writeFile({ path: p, content: "x" })).rejects.toThrow();
  });
  it("symlink_out_is_blocked_for_read_and_write", async () => {
    const { base, jail, t } = await setup();
    await writeFile(path.join(base, "secret.txt"), "s");
    await symlink(path.join(base, "secret.txt"), path.join(jail.root, "link.txt"));
    await symlink(base, path.join(jail.root, "dir"));
    await expect(t.readFile({ path: "link.txt" })).rejects.toThrow(/escapes/);
    await expect(t.writeFile({ path: "dir/new.txt", content: "x" })).rejects.toThrow(/escapes/);
  });
});
