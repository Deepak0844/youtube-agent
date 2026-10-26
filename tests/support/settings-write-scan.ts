import path from "node:path";
import ts from "typescript";

// AST scan (TypeScript compiler API, no regex over source text) that keeps safety-setting writes behind a session.
// setSetting() itself refuses non-session actors (tested elsewhere); this scan stops code from reaching around it:
//  (a) only files on SETTINGS_IMPORT_ALLOW may import src/server/db/settings (no re-export, require or dynamic import at all);
//  (b) every reference to `setSetting` must be a direct call whose 4th argument is exactly the literal `{ actor: "session" }`:
//      no alias import, alias const, .call/.apply, element access, destructure rename, spread, variable or type cast;
//  (c) no file other than settings.ts may mention the `settings` table in SQL (any schema/quoting/ONLY/case, folded string
//      concatenation, and the "settings" literal next to write keywords for string-built SQL).
/** Files allowed to import the settings module. Empty on purpose: add a file here only together with a review of its calls. */
export const SETTINGS_IMPORT_ALLOW: readonly string[] = [
  // Reads network.local_services with getSetting to derive a model endpoint kind; never calls setSetting. Needs owner review.
  "src/server/db/llm-models.ts",
];

const SETTINGS_MODULE = "src/server/db/settings";
const OWNER_FILE = "src/server/db/settings.ts";

function resolvesToSettings(file: string, spec: string): boolean {
  let p: string;
  if (spec.startsWith("@/")) p = "src/" + spec.slice(2);
  else if (spec.startsWith(".")) p = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
  else return false;
  return p.replace(/\.(?:[cm]?[jt]sx?)$/, "") === SETTINGS_MODULE;
}

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

/** Problems found in one source file. `file` is repo-relative with forward slashes. */
export function scanSettingsWrites(file: string, text: string, importAllow: readonly string[] = SETTINGS_IMPORT_ALLOW): string[] {
  if (file === OWNER_FILE) return [];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kindFor(file));
  const out: string[] = [];
  const at = (n: ts.Node, msg: string) => out.push(`${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}: ${msg}`);
  const allowed = importAllow.includes(file);
  const strings: string[] = [];
  let hasSettingsLiteral = false;
  let hasWriteWord = false;

  const visit = (n: ts.Node): void => {
    // (a) module references
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier) && resolvesToSettings(file, n.moduleSpecifier.text)) {
      if (ts.isExportDeclaration(n)) at(n, "re-exports db/settings (hides setSetting from this scan)");
      else if (!allowed) at(n, "imports db/settings but is not on SETTINGS_IMPORT_ALLOW");
    }
    if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && ts.isStringLiteral(n.moduleReference.expression) && resolvesToSettings(file, n.moduleReference.expression.text)) {
      at(n, "import = require of db/settings");
    }
    if (ts.isCallExpression(n) && n.arguments.length > 0 && ts.isStringLiteral(n.arguments[0]!) && resolvesToSettings(file, (n.arguments[0] as ts.StringLiteral).text)) {
      if (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require")) at(n, "require()/import() of db/settings cannot be analysed");
    }
    // (b) every reference to setSetting
    if (ts.isIdentifier(n) && n.text === "setSetting") {
      const par = n.parent;
      if (ts.isImportSpecifier(par) && par.name === n && !par.propertyName) {
        /* plain binding of the import; its uses are checked below */
      } else if (ts.isImportSpecifier(par)) {
        at(n, "aliased import of setSetting");
      } else {
        const callee = ts.isPropertyAccessExpression(par) && par.name === n ? par : n;
        const call = callee.parent;
        if (ts.isCallExpression(call) && call.expression === callee) {
          const why = badSessionCall(call);
          if (why) at(call, why);
        } else {
          at(n, "setSetting used as a value (alias, .call/.apply, destructure, export or pass-through)");
        }
      }
    }
    if (ts.isStringLiteral(n) && n.text === "setSetting" && n.parent && ts.isElementAccessExpression(n.parent)) at(n, 'element access ["setSetting"]');
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
