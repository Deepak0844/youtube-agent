import ts from "typescript";
import type { ToonInput } from "../../../remotion/kit/toon/context";
import { markProblem, resolveMark, type ToonTimeline } from "../../../remotion/kit/toon/time";

// The scene check for a cartoon video, on top of checkTsx: a scene may only name characters that are in the cast and only use beat marks that exist
// (a render would crash on either, after minutes of work). Reads the string literals the scene writes: `who="Name"`, marks in props (from, to, at,
// until, a, b, during, enter / words / scenes entries) and in T("...") / prog(t, "...", "...") calls. A value that is computed cannot be read here;
// the kit refuses it with the same plain message when the frame is drawn. Pure.

const MARK_PROPS = new Set(["from", "to", "at", "until", "a", "b"]);
const MAX_PROBLEMS = 10;

const lit = (n: ts.Node | undefined): string | number | null => {
  if (!n) return null;
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isNumericLiteral(n)) return Number(n.text);
  if (ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(n.operand)) return -Number(n.operand.text);
  return null;
};
const isToonImport = (spec: string) => spec.startsWith("yt-toon/");

export function checkToon(source: string, input: ToonInput): string[] {
  const sf = ts.createSourceFile("video.tsx", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const problems: string[] = [];
  const add = (n: ts.Node, msg: string) => {
    if (problems.length >= MAX_PROBLEMS) return;
    const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    problems.push(`line ${line}: ${msg}`);
  };
  const names = input.cast.map((c) => c.name);

  // names imported from yt-toon modules (only those elements are checked)
  const toon = new Set<string>();
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && isToonImport(st.moduleSpecifier.text) && st.importClause?.namedBindings && ts.isNamedImports(st.importClause.namedBindings)) {
      for (const el of st.importClause.namedBindings.elements) toon.add(el.name.text);
    }
  }
  const beatsOnly: ToonTimeline = { beats: input.timeline.beats, scenes: [] };

  // the film's scene windows: the literal `scenes={[{ id, from, to }, ...]}` of <ToonFilm>, else the host's
  let timeline: ToonTimeline = input.timeline;
  const declared: string[] = [];
  const walk = (n: ts.Node, fn: (n: ts.Node) => void) => {
    fn(n);
    ts.forEachChild(n, (k) => walk(k, fn));
  };
  walk(sf, (n) => {
    if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && n.tagName.getText(sf) === "ToonFilm" && toon.has("ToonFilm")) {
      for (const a of n.attributes.properties) {
        if (!ts.isJsxAttribute(a) || a.name.getText(sf) !== "scenes" || !a.initializer || !ts.isJsxExpression(a.initializer) || !a.initializer.expression || !ts.isArrayLiteralExpression(a.initializer.expression)) continue;
        const spans: { id: string; startS: number; endS: number }[] = [];
        for (const e of a.initializer.expression.elements) {
          if (!ts.isObjectLiteralExpression(e)) continue;
          const get = (k: string) => {
            const p = e.properties.find((q): q is ts.PropertyAssignment => ts.isPropertyAssignment(q) && q.name.getText(sf) === k);
            return p ? lit(p.initializer) : null;
          };
          const id = get("id");
          const from = get("from");
          const to = get("to");
          if (typeof id !== "string" || from === null || to === null) continue;
          declared.push(id);
          const f = typeof from === "string" ? markProblem(from, beatsOnly) : null;
          const t = typeof to === "string" ? markProblem(to, beatsOnly) : null;
          if (f) add(e, `scenes: '${String(from).slice(0, 30)}' ${f.startsWith("no beat") ? `is not a beat (${f})` : f}; use beat marks like B0 or B3e.`);
          else if (t) add(e, `scenes: '${String(to).slice(0, 30)}' ${t.startsWith("no beat") ? `is not a beat (${t})` : t}; use beat marks like B0 or B3e.`);
          else spans.push({ id, startS: resolveMark(from, beatsOnly), endS: resolveMark(to, beatsOnly) });
        }
        if (spans.length > 0) timeline = { beats: input.timeline.beats, scenes: spans };
      }
    }
  });
  const sceneIds = declared.length > 0 ? declared : input.timeline.scenes.map((s) => s.id);

  const checkMark = (n: ts.Node, v: string | number | null, what: string) => {
    if (v === null || typeof v === "number") return; // computed values and plain seconds are not checked here
    const p = markProblem(v, timeline);
    if (p) add(n, `marks: ${what} '${v.slice(0, 30)}': ${p}; the video has ${input.timeline.beats.length} beats (B0 to B${Math.max(0, input.timeline.beats.length - 1)}).`);
  };
  const checkDuring = (n: ts.Node, v: string | number | null) => {
    if (typeof v !== "string") return;
    for (const range of v.split(",")) for (const part of range.split("..")) checkMark(n, part.trim(), "during");
  };
  const checkObjectMarks = (o: ts.ObjectLiteralExpression, keys: Set<string>) => {
    for (const p of o.properties) if (ts.isPropertyAssignment(p) && keys.has(p.name.getText(sf))) checkMark(p, lit(p.initializer), p.name.getText(sf));
  };

  walk(sf, (n) => {
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const tag = n.tagName.getText(sf);
      if (!toon.has(tag)) return;
      for (const a of n.attributes.properties) {
        if (!ts.isJsxAttribute(a)) continue;
        const name = a.name.getText(sf);
        const init = a.initializer;
        const expr = init && ts.isJsxExpression(init) ? init.expression : init;
        const value = lit(expr);
        if (name === "who") {
          if (typeof value === "string" && !names.includes(value)) add(a, `cast: '${value.slice(0, 30)}' is not in the cast (${names.join(", ") || "empty"}); use one of those names or options={...} for a one-off.`);
        } else if (MARK_PROPS.has(name) && tag !== "ToonFilm") {
          checkMark(a, value, name);
        } else if (name === "during") {
          checkDuring(a, value);
        } else if (name === "id" && tag === "Scene" && typeof value === "string" && sceneIds.length > 0 && !sceneIds.includes(value)) {
          add(a, `scenes: <Scene id="${value.slice(0, 30)}"> is not in the film's scenes (${sceneIds.join(", ")}); add it to <ToonFilm scenes={[...]}>.`);
        } else if ((name === "enter" || name === "words") && expr && ts.isArrayLiteralExpression(expr)) {
          for (const e of expr.elements) if (ts.isObjectLiteralExpression(e)) checkObjectMarks(e, new Set(["at", "until"]));
        }
      }
    } else if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      if (n.expression.text === "T") checkMark(n, lit(n.arguments[0]), "T()");
      else if (n.expression.text === "prog") {
        checkMark(n, lit(n.arguments[1]), "prog()");
        checkMark(n, lit(n.arguments[2]), "prog()");
      }
    }
  });
  return problems;
}
