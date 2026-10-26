import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentTool } from "@/server/core/agent-loop";

// File tools jailed to one run's scratch directory (Doc 8 §2). Every path is resolved through realpath on its
// deepest existing ancestor, so `..` and symlinks cannot escape. No shell, no network, no secrets.

const MAX_FILE_BYTES = 1024 * 1024;

export async function createJail(rootDir: string) {
  await mkdir(rootDir, { recursive: true });
  const root = await realpath(rootDir);

  async function resolveInside(rel: unknown): Promise<string> {
    if (typeof rel !== "string" || rel.length === 0 || rel.includes("\0")) throw new Error("invalid path");
    if (path.isAbsolute(rel)) throw new Error("path escapes the jail");
    const abs = path.resolve(root, rel);
    let probe = abs;
    for (;;) {
      try {
        const real = await realpath(probe);
        const full = path.join(real, path.relative(probe, abs));
        if (full !== root && !full.startsWith(root + path.sep)) throw new Error("path escapes the jail");
        return full;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        const parent = path.dirname(probe);
        if (parent === probe) throw new Error("path escapes the jail");
        probe = parent;
      }
    }
  }
  const arg = (a: unknown, k: string): unknown => (typeof a === "object" && a !== null ? (a as Record<string, unknown>)[k] : undefined);

  const tools: AgentTool[] = [
    {
      name: "readFile",
      async run(a) {
        const buf = await readFile(await resolveInside(arg(a, "path")));
        if (buf.byteLength > MAX_FILE_BYTES) throw new Error("file too large");
        return buf.toString("utf8");
      },
    },
    {
      name: "writeFile",
      async run(a) {
        const content = arg(a, "content");
        if (typeof content !== "string" || Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error("invalid content");
        const target = await resolveInside(arg(a, "path"));
        await mkdir(path.dirname(target), { recursive: true });
        // re-check after mkdir: the parent now exists, so symlinked parents are caught
        if ((await resolveInside(arg(a, "path"))) !== target) throw new Error("path escapes the jail");
        await writeFile(target, content, "utf8");
        return "ok";
      },
    },
    {
      name: "listDir",
      async run(a) {
        const rel = arg(a, "path");
        const names = await readdir(await resolveInside(rel === undefined || rel === "" ? "." : rel));
        return names.join("\n");
      },
    },
  ];
  return { root, tools };
}
