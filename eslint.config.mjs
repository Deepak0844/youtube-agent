import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Flat config replaces (not merges) a rule across overlapping blocks, so each
// block below lists its full set from these shared groups.
const framework = ["react", "react-dom", "next", "next/*"];
const presentation = ["@/app/*", "@/ui/*"];
const io = [
  "fs", "fs/promises", "net", "http", "https", "child_process", "dgram", "dns", "tls",
  "node:fs", "node:fs/promises", "node:net", "node:http", "node:https",
  "node:child_process", "node:dgram", "node:dns", "node:tls",
];
const effects = ["@/server/db", "@/server/db/*", "@/server/providers", "@/server/providers/*", "@/server/llm", "@/server/llm/*", "@/server/queue", "@/server/queue/*"];
const orm = ["drizzle-orm", "drizzle-orm/*"];

const restrict = (...groups) => ({
  "no-restricted-imports": ["error", { patterns: [{ group: groups.flat() }] }],
});

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Agent tooling, not app code.
    ".claude/**",
  ]),
  // Import boundaries (Doc 2 §2). Raw table access is db-only; the package is
  // not installed yet, the rule is pre-wired.
  { files: ["src/**/*.{ts,tsx}"], ignores: ["src/server/**", "src/worker/**"], rules: restrict(orm) },
  { files: ["src/server/**/*.ts", "src/worker/**/*.ts"], rules: restrict(framework, presentation, orm) },
  { files: ["src/server/db/**/*.ts"], rules: restrict(framework, presentation) },
  { files: ["src/server/core/**/*.ts"], rules: restrict(framework, presentation, orm, io, effects) },
]);

export default eslintConfig;
