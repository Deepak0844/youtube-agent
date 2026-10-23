import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint();

async function errorsFor(filePath: string, code: string) {
  const [result] = await eslint.lintText(code, {
    filePath: `${process.cwd()}/${filePath}`,
  });
  return (result?.messages ?? []).filter(
    (m) => m.ruleId === "no-restricted-imports",
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
});
