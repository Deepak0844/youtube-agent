import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { generateMasterKey } from "@/server/core/vault-crypto";

// Generates VAULT_MASTER_KEY and appends it to .env.local (override path with VAULT_ENV_FILE, used by tests).
// Refuses if the key is already defined ANYWHERE it could be loaded from: the process env, or .env, .env.local,
// .env.development.local, .env.production.local in the same directory. Replacing a key orphans every stored secret.
// The key is never printed. An existing file is chmod 0600 first and only appended to (never rewritten).
const file = path.resolve(process.env.VAULT_ENV_FILE || ".env.local");
const root = path.dirname(file);
// `export`, leading spaces/tabs, `=` or `:`, CRLF all count; a commented line does not start with the name so it does not.
const DEFINES = /^[ \t]*(?:export[ \t]+)?VAULT_MASTER_KEY[ \t]*[=:]/m;

const sources = [file, ...[".env", ".env.local", ".env.development.local", ".env.production.local"].map((n) => path.join(root, n))];
const holders = [
  ...(process.env.VAULT_MASTER_KEY !== undefined ? ["the process environment"] : []),
  ...[...new Set(sources)].filter((f) => existsSync(f) && DEFINES.test(readFileSync(f, "utf8"))).map((f) => path.basename(f)),
];
if (holders.length > 0) {
  process.stderr.write(`refused: VAULT_MASTER_KEY is already defined in ${holders.join(", ")}. Overwriting it would make stored secrets unreadable.\n`);
  process.exit(1);
}

const line = `VAULT_MASTER_KEY=${generateMasterKey()}\n`;
if (existsSync(file)) {
  chmodSync(file, 0o600); // tighten BEFORE the key is written
  const existing = readFileSync(file, "utf8");
  appendFileSync(file, (existing === "" || existing.endsWith("\n") ? "" : "\n") + line);
} else {
  writeFileSync(file, line, { flag: "wx", mode: 0o600 });
}
process.stdout.write(
  [
    `VAULT_MASTER_KEY written to ${file} (mode 0600). The key is not shown.`,
    "BACK IT UP NOW: copy that line into your password manager. If the key is lost, every stored secret is unrecoverable.",
    "Keep .env.local out of git (it is gitignored) and out of screenshots, logs and chat.",
    "Run `npm run vault:check` to verify.",
    "",
  ].join("\n"),
);
