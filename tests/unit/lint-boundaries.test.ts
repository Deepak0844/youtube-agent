import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint();

async function errorsFor(filePath: string, code: string) {
  const [result] = await eslint.lintText(code, {
    filePath: `${process.cwd()}/${filePath}`,
  });
  return (result?.messages ?? []).filter((m) =>
    ["no-restricted-imports", "no-restricted-globals", "no-restricted-syntax"].includes(m.ruleId ?? ""),
  );
}

describe("import boundaries", () => {
  it("lints_react_import_in_server_is_error", async () => {
    const e = await errorsFor("src/server/llm/a.ts", 'import React from "react";\nexport const a = React;\n');
    expect(e).toHaveLength(1);
  });

  it("core_importing_fs_is_error", async () => {
    const e = await errorsFor("src/server/core/a.ts", 'import fs from "node:fs";\nexport const a = fs;\n');
    expect(e).toHaveLength(1);
  });

  it("core_importing_db_is_error", async () => {
    const e = await errorsFor("src/server/core/a.ts", 'import * as db from "@/server/db";\nexport const a = db;\n');
    expect(e).toHaveLength(1);
  });

  it("providers_importing_fs_is_ok", async () => {
    const e = await errorsFor("src/server/providers/a.ts", 'import fs from "node:fs";\nexport const a = fs;\n');
    expect(e).toHaveLength(0);
  });

  it("ui_importing_server_core_is_ok", async () => {
    const e = await errorsFor("src/ui/a.ts", 'import { x } from "@/server/core/sanity";\nexport const a = x;\n');
    expect(e).toHaveLength(0);
  });

  it("server_importing_ui_is_error", async () => {
    const e = await errorsFor("src/worker/a.ts", 'import { a } from "@/ui/button";\nexport const b = a;\n');
    expect(e).toHaveLength(1);
  });

  it("drizzle_outside_db_is_error", async () => {
    const e = await errorsFor("src/server/queue/a.ts", 'import { sql } from "drizzle-orm";\nexport const b = sql;\n');
    expect(e).toHaveLength(1);
  });

  it.each([
    ["relative db import from core", "src/server/core/a.ts", 'import * as db from "../db";\nexport const a = db;\n'],
    ["relative ui import from server", "src/server/llm/a.ts", 'import { b } from "../../ui/button";\nexport const a = b;\n'],
    ["react in a .tsx under server", "src/server/render/a.tsx", 'import React from "react";\nexport const a = React;\n'],
    ["node:fs in a .tsx under core", "src/server/core/a.tsx", 'import fs from "node:fs";\nexport const a = fs;\n'],
    ["pg in core", "src/server/core/a.ts", 'import pg from "pg";\nexport const a = pg;\n'],
    ["ioredis in core", "src/server/core/a.ts", 'import { Redis } from "ioredis";\nexport const a = Redis;\n'],
    ["bullmq in core", "src/server/core/a.ts", 'import { Queue } from "bullmq";\nexport const a = Queue;\n'],
    ["undici in core", "src/server/core/a.ts", 'import { fetch } from "undici";\nexport const a = fetch;\n'],
    ["node:http2 in core", "src/server/core/a.ts", 'import h from "node:http2";\nexport const a = h;\n'],
    ["@/server/authoring in core", "src/server/core/a.ts", 'import * as r from "@/server/authoring/draft";\nexport const a = r;\n'],
    ["@/server/render in core", "src/server/core/a.ts", 'import * as r from "@/server/render";\nexport const a = r;\n'],
    ["fetch global in core", "src/server/core/a.ts", 'export const a = () => fetch("https://example.com");\n'],
    ["dynamic import in core", "src/server/core/a.ts", 'export const a = () => import("node:fs");\n'],
  ])("%s is an error", async (_name, file, code) => {
    expect((await errorsFor(file, code)).length).toBeGreaterThan(0);
  });

  it("relative imports between core files are fine", async () => {
    const e = await errorsFor("src/server/core/a.ts", 'import { b } from "./b";\nexport const a = b;\n');
    expect(e).toHaveLength(0);
  });
});
