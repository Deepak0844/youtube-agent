import path from "node:path";
import ts from "typescript";

// AST scan (TypeScript compiler API, no regex over source text) that keeps safety-setting writes behind a session.
// setSetting() itself refuses non-session actors (tested elsewhere); this scan stops code from reaching around it:
//  (a) only files on SETTINGS_IMPORT_ALLOW may import src/server/db/settings (no re-export, require or dynamic import at all);
//  (b) every reference to `setSetting` must be a direct call whose 4th argument is exactly the literal `{ actor: "session" }`:
//      no alias import, alias const, .call/.apply, element access, destructure rename, spread, variable or type cast;
//  (c) no file other than settings.ts may mention the `settings` table in SQL (any schema/quoting/ONLY/case, folded string
//      concatenation, and the "settings" literal next to write keywords for string-built SQL).
//  (d) setSessionSettings (writes as a session, no actor argument) is treated like setSetting: only allow-listed files may
//      import it, only by its own name, only as a direct three-argument call; settings.ts itself limits it to a fixed key set;
//  (e) the system-settings writers (saveLocalServices, saveSystemSettings) may only be imported, by name and called directly,
//      from the files on SESSION_WRITER_IMPORT_ALLOW, so a new importer cannot reach the safety-setting write path unseen.
/**
 * Files allowed to import the settings module, each with the names it may import (type-only imports are exempt). Empty
 * names are not allowed: add a file here only together with a review of its calls.
 * system-settings.ts (Phase 1 Task 10) calls only getSetting and setSessionSettings; it never calls setSetting.
 */
export type ImportAllow = Readonly<Record<string, readonly string[]>>;
export const SETTINGS_IMPORT_ALLOW: ImportAllow = {
  // Read-only batch read of the engine numbers (getEngineConfig); never writes.
  "src/server/db/engine-config.ts": ["getStoredSettings"],
  // Reads network.local_services with getSetting to derive a model endpoint kind and uses the Actor type; never writes.
  "src/server/db/llm-models.ts": ["getSetting", "Actor"],
  "src/server/db/system-settings.ts": ["getSetting", "setSessionSettings"],
};

/** The only file(s) that may import the system-settings writers: the guarded server actions (requireOwner first). */
export const SESSION_WRITER_IMPORT_ALLOW: ImportAllow = {
  "src/app/(app)/settings/system/actions.ts": ["saveLocalServices", "saveSystemSettings"],
};
export const SESSION_WRITERS = ["saveLocalServices", "saveSystemSettings"] as const;
const GUARDED: readonly string[] = ["setSetting", "setSessionSettings", ...SESSION_WRITERS];

const SETTINGS_MODULE = "src/server/db/settings";
const SYSTEM_SETTINGS_MODULE = "src/server/db/system-settings";
const SYSTEM_SETTINGS_FILE = "src/server/db/system-settings.ts";
const OWNER_FILE = "src/server/db/settings.ts";

function resolvesTo(file: string, spec: string, module: string): boolean {
  let p: string;
  if (spec.startsWith("@/")) p = "src/" + spec.slice(2);
  else if (spec.startsWith(".")) p = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
  else return false;
  return p.replace(/\.(?:[cm]?[jt]sx?)$/, "") === module;
}
const resolvesToSettings = (file: string, spec: string) => resolvesTo(file, spec, SETTINGS_MODULE);
const resolvesToSystemSettings = (file: string, spec: string) => resolvesTo(file, spec, SYSTEM_SETTINGS_MODULE);

const kindFor = (file: string) => (/\.tsx$/.test(file) ? ts.ScriptKind.TSX : /\.jsx$/.test(file) ? ts.ScriptKind.JSX : /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS);

/** Text of a string-ish expression with `+` chains folded; unknown parts become a neutral placeholder. null = not string-ish. */
function fold(n: ts.Node): string | null {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isTemplateExpression(n)) return n.head.text + n.templateSpans.map((s) => "x" + s.literal.text).join("");
  if (ts.isParenthesizedExpression(n)) return fold(n.expression);
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = fold(n.left);
    const r = fold(n.right);
    if (l === null && r === null) return null;
    return (l ?? "x") + (r ?? "x");
  }
  return null;
}

const SQL_TABLE = /\b(?:from|into|update|join|table|truncate|only)\s+(?:only\s+)?(?:"?\w+"?\.)?"?settings"?(?![\w$])/i;
const SQL_WRITE_WORD = /\b(?:insert|update|delete|truncate|alter|drop)\b/i;

function badSessionCall(call: ts.CallExpression): string | null {
  const a = call.arguments;
  if (a.length !== 4) return "setSetting must be called with exactly four arguments";
  const o = a[3]!;
  if (!ts.isObjectLiteralExpression(o) || o.properties.length !== 1) return 'the options argument must be exactly the literal { actor: "session" } (no spread, no extra keys, no variable, no cast)';
  const p = o.properties[0]!;
  const nameOk = ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "actor";
  if (!nameOk || !ts.isStringLiteral((p as ts.PropertyAssignment).initializer) || ((p as ts.PropertyAssignment).initializer as ts.StringLiteral).text !== "session") {
    return 'the actor must be the plain string literal "session" (no cast, variable or other actor)';
  }
  return null;
}

function badSessionWriterCall(call: ts.CallExpression): string | null {
  return call.arguments.length === 3 ? null : "setSessionSettings must be called directly with exactly three arguments";
}

/** An allow-list given as a plain file list (self-tests) means "any names"; the real maps name each file's imports. */
type AllowArg = readonly string[] | ImportAllow;
const namesFor = (allow: AllowArg, file: string): readonly string[] | null | undefined =>
  Array.isArray(allow) ? ((allow as readonly string[]).includes(file) ? null : undefined) : (Object.hasOwn(allow, file) ? (allow as ImportAllow)[file] : undefined);

/** Problems found in one source file. `file` is repo-relative with forward slashes. */
export function scanSettingsWrites(
  file: string,
  text: string,
  importAllow: AllowArg = SETTINGS_IMPORT_ALLOW,
  writerAllow: AllowArg = SESSION_WRITER_IMPORT_ALLOW,
): string[] {
  if (file === OWNER_FILE) return [];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kindFor(file));
  const out: string[] = [];
  const at = (n: ts.Node, msg: string) => out.push(`${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}: ${msg}`);
  const settingsNames = namesFor(importAllow, file); // undefined: file not allowed; null: any names
  const allowed = settingsNames !== undefined;
  const writerNames = namesFor(writerAllow, file);
  const isSystemSettingsFile = file === SYSTEM_SETTINGS_FILE;
  const strings: string[] = [];
  let hasSettingsLiteral = false;
  let hasWriteWord = false;

  // Shared by (a) and (e): the shape of one import of a guarded module. `names` is the file's permitted import list.
  const checkImportClause = (n: ts.ImportDeclaration, label: string, names: readonly string[] | null | undefined, guarded?: readonly string[]) => {
    const c = n.importClause;
    if (!c) {
      at(n, `side-effect import of ${label} cannot be analysed`);
      return;
    }
    if (c.name) at(n, `default import of ${label} cannot be analysed`);
    if (c.namedBindings && ts.isNamespaceImport(c.namedBindings)) at(n, `namespace import of ${label} cannot be analysed`);
    if (c.namedBindings && ts.isNamedImports(c.namedBindings)) {
      for (const spec of c.namedBindings.elements) {
        const name = (spec.propertyName ?? spec.name).text;
        // An alias of a harmless permitted name (getSetting as g) is fine; an alias of a guarded name hides its calls.
        if (spec.propertyName && GUARDED.includes(name)) at(spec, `aliased import of ${name} from ${label}`);
        const typeOnly = c.isTypeOnly || spec.isTypeOnly;
        if (typeOnly) continue;
        if (guarded && !guarded.includes(name)) continue; // only the guarded names are restricted from this module
        if (names === undefined || (names !== null && !names.includes(name))) at(spec, `imports ${name} from ${label}, which is not on this file's allow-list`);
      }
    }
  };

  const visit = (n: ts.Node): void => {
    // (a) module references
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier) && resolvesToSettings(file, n.moduleSpecifier.text)) {
      if (ts.isExportDeclaration(n)) at(n, "re-exports db/settings (hides setSetting from this scan)");
      else {
        if (!allowed) at(n, "imports db/settings but is not on SETTINGS_IMPORT_ALLOW");
        checkImportClause(n, "db/settings", settingsNames);
      }
    }
    if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && ts.isStringLiteral(n.moduleReference.expression) && resolvesToSettings(file, n.moduleReference.expression.text)) {
      at(n, "import = require of db/settings");
    }
    if (ts.isCallExpression(n) && n.arguments.length > 0 && ts.isStringLiteral(n.arguments[0]!) && resolvesToSettings(file, (n.arguments[0] as ts.StringLiteral).text)) {
      if (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require")) at(n, "require()/import() of db/settings cannot be analysed");
    }
    // (e) the system-settings writers
    if (!isSystemSettingsFile) {
      if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier) && resolvesToSystemSettings(file, n.moduleSpecifier.text)) {
        if (ts.isExportDeclaration(n)) at(n, "re-exports system-settings (hides the session writers from this scan)");
        else checkImportClause(n, "system-settings", writerNames, SESSION_WRITERS);
      }
      if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && ts.isStringLiteral(n.moduleReference.expression) && resolvesToSystemSettings(file, n.moduleReference.expression.text)) {
        at(n, "import = require of system-settings");
      }
      if (ts.isCallExpression(n) && n.arguments.length > 0 && ts.isStringLiteral(n.arguments[0]!) && resolvesToSystemSettings(file, (n.arguments[0] as ts.StringLiteral).text)) {
        if (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require")) at(n, "require()/import() of system-settings cannot be analysed");
      }
    }
    // (b) and (d): every reference to setSetting, setSessionSettings and the system-settings writers
    const guardedName = ts.isIdentifier(n) && (n.text === "setSetting" || n.text === "setSessionSettings" || (!isSystemSettingsFile && (SESSION_WRITERS as readonly string[]).includes(n.text))) ? n.text : null;
    if (ts.isIdentifier(n) && guardedName) {
      const par = n.parent;
      if (ts.isImportSpecifier(par) && par.name === n && !par.propertyName) {
        /* plain binding of the import; its uses are checked below */
      } else if (ts.isImportSpecifier(par)) {
        at(n, `aliased import of ${guardedName}`);
      } else {
        const callee = ts.isPropertyAccessExpression(par) && par.name === n ? par : n;
        const call = callee.parent;
        if (ts.isCallExpression(call) && call.expression === callee) {
          const why = guardedName === "setSetting" ? badSessionCall(call) : guardedName === "setSessionSettings" ? badSessionWriterCall(call) : null;
          if (why) at(call, why);
        } else {
          at(n, `${guardedName} used as a value (alias, .call/.apply, destructure, export or pass-through)`);
        }
      }
    }
    if (ts.isStringLiteral(n) && (n.text === "setSetting" || n.text === "setSessionSettings" || (!isSystemSettingsFile && (SESSION_WRITERS as readonly string[]).includes(n.text))) && n.parent && ts.isElementAccessExpression(n.parent)) {
      at(n, `element access ["${n.text}"]`);
    }
    // (c) SQL on the settings table
    const isChainPart = n.parent && ts.isBinaryExpression(n.parent) && n.parent.operatorToken.kind === ts.SyntaxKind.PlusToken && fold(n.parent) !== null;
    if (!isChainPart) {
      const f = fold(n);
      if (f !== null) {
        strings.push(f);
        if (SQL_TABLE.test(f)) at(n, "SQL touches the settings table outside src/server/db/settings.ts");
      }
    }
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      if (n.text.trim().replace(/^"|"$/g, "") === "settings") hasSettingsLiteral = true;
      if (SQL_WRITE_WORD.test(n.text)) hasWriteWord = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (hasSettingsLiteral && hasWriteWord && !out.some((m) => m.includes("SQL touches"))) out.push(`${file}: a bare "settings" string next to write keywords looks like string-built SQL`);
  return out;
}
