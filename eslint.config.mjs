import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Flat config replaces (not merges) a rule across overlapping blocks, so each
// block below lists its full set from these shared groups. Relative patterns
// (`**/db`) catch `../db` imports that the `@/` aliases would miss.
const framework = ["react", "react-dom", "next", "next/*"];
const presentation = ["@/app/*", "@/ui/*", "**/ui", "**/ui/*", "**/app", "**/app/*"];
const nodeIo = ["fs", "fs/promises", "net", "http", "http2", "https", "child_process", "dgram", "dns", "tls"];
const ioPackages = ["pg", "ioredis", "bullmq", "undici"];
const io = [...nodeIo, ...nodeIo.map((m) => `node:${m}`), ...ioPackages];
const effectDirs = ["db", "providers", "llm", "queue", "render"];
const effects = effectDirs.flatMap((d) => [`@/server/${d}`, `@/server/${d}/*`, `**/${d}`, `**/${d}/*`]);
const orm = ["drizzle-orm", "drizzle-orm/*"];

const restrict = (...groups) => ({
  "no-restricted-imports": ["error", { patterns: [{ group: groups.flat() }] }],
});

const coreOnly = {
  "no-restricted-globals": [
    "error",
    ...["fetch", "WebSocket", "XMLHttpRequest"].map((name) => ({ name, message: "server/core does no IO; inject a port." })),
  ],
  "no-restricted-syntax": [
    "error",
    { selector: "ImportExpression", message: "server/core does no IO; dynamic import could hide it." },
  ],
};

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
  { files: ["src/**/*.{ts,tsx,mts}"], ignores: ["src/server/**", "src/worker/**"], rules: restrict(orm) },
  { files: ["src/server/**/*.{ts,tsx,mts}", "src/worker/**/*.{ts,tsx,mts}"], rules: restrict(framework, presentation, orm) },
  { files: ["src/server/db/**/*.{ts,tsx,mts}"], rules: restrict(framework, presentation) },
  { files: ["src/server/core/**/*.{ts,tsx,mts}"], rules: { ...restrict(framework, presentation, orm, io, effects), ...coreOnly } },
]);

export default eslintConfig;
