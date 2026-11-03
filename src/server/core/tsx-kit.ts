import ts from "typescript";
import { YT_KIT_DTS } from "@/server/core/tsx-kit-dts";

// The "yt-kit" import of the code-scene (TSX) path. remotion/kit/tsxlib/yt-kit.d.ts is the ONE list of exported names and prop
// types: the type-check worker types the import with it, checkTsx allows exactly its value names, and the prompt documents
// them from its one-line comments. The text is embedded in tsx-kit-dts.ts (server/core reads no files; scripts/sync-tsx-kit-dts.mjs copies it, a test checks it).

export const YT_KIT_MODULE = "yt-kit";

const parse = (dts: string): ts.SourceFile => ts.createSourceFile("yt-kit.d.ts", dts, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
const isExported = (n: ts.Node): boolean => ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
const comment = (sf: ts.SourceFile, n: ts.Node): string => {
  const r = ts.getLeadingCommentRanges(sf.text, n.getFullStart())?.pop();
  return r ? sf.text.slice(r.pos, r.end).replace(/^\/\*\*?|\*\/$/g, "").replace(/\s+/g, " ").trim() : "";
};
const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Every exported VALUE name (const / function) of the declaration file, in file order. Type exports are not importable values. */
export function kitExportNames(dts: string): string[] {
  const names: string[] = [];
  for (const st of parse(dts).statements) {
    if (!isExported(st)) continue;
    if (ts.isFunctionDeclaration(st) && st.name) names.push(st.name.text);
    else if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) names.push(d.name.text);
  }
  return names;
}

/** One line per export for the prompt: name, props (type shown only when it is not number), and the comment. Generated, so docs cannot drift. */
export function kitDocs(dts: string): string {
  const sf = parse(dts);
  const lines: string[] = [];
  for (const st of sf.statements) {
    if (!isExported(st)) continue;
    const note = comment(sf, st);
    const tail = note ? ` - ${note}` : "";
    if (ts.isTypeAliasDeclaration(st)) lines.push(`- type ${st.name.text} = ${squash(st.type.getText(sf))}`);
    else if (ts.isFunctionDeclaration(st) && st.name) lines.push(`- ${st.name.text}(${st.parameters.map((p) => squash(p.getText(sf))).join(", ")})${tail}`);
    else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.type) continue;
        const arg = ts.isTypeReferenceNode(d.type) && d.type.typeName.getText(sf) === "FC" ? d.type.typeArguments?.[0] : undefined;
        if (arg && ts.isTypeLiteralNode(arg)) {
          const props = arg.members.filter(ts.isPropertySignature).map((m) => {
            const t = m.type ? squash(m.type.getText(sf)) : "";
            return `${m.name.getText(sf)}${m.questionToken ? "?" : ""}${t && t !== "number" ? `: ${t}` : ""}`;
          });
          lines.push(`- ${d.name.text} {${props.join(", ")}}${tail}`);
        } else lines.push(`- ${d.name.text}: ${squash(d.type.getText(sf))}${tail}`);
      }
    }
  }
  return lines.join("\n");
}


/** The allowed value names of `import { ... } from "yt-kit"`. */
export const YT_KIT_NAMES: readonly string[] = kitExportNames(YT_KIT_DTS);
