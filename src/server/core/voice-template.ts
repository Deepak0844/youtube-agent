import { KnownFailure } from "./paid-call";

// SECURITY CONTROL: the custom voice server's request body. The owner writes JSON text; {text}, {voice} and {lang} may stand
// in for a WHOLE string value and nothing else. Values are put in as JSON strings (never spliced into text), the result is
// serialised again and checked to have the same shape, so script text cannot add keys, close a string or change a type.
// Pure: no IO.

export class TemplateError extends KnownFailure {
  constructor(message: string) {
    super(message);
    this.name = "TemplateError";
  }
}

export interface TemplateVars { text: string; voice: string; lang: string }
const NAMES = ["text", "voice", "lang"] as const;

function fill(node: unknown, vars: TemplateVars): unknown {
  if (typeof node === "string") {
    const whole = /^\{(\w+)\}$/.exec(node);
    if (whole && (NAMES as readonly string[]).includes(whole[1]!)) return vars[whole[1] as keyof TemplateVars];
    if (/[{}]/.test(node)) throw new TemplateError("The body template has a placeholder that is unknown, unbalanced or not a whole value. Use only {text}, {voice} and {lang}, each as a complete string value.");
    return node;
  }
  if (Array.isArray(node)) return node.map((n) => fill(n, vars));
  if (node !== null && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (/[{}]/.test(k)) throw new TemplateError("A placeholder cannot be used in a key of the body template.");
      out[k] = fill(v, vars);
    }
    return out;
  }
  return node;
}

function shape(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(shape);
  if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)]));
  return v === null ? "null" : typeof v;
}

export function renderBodyTemplate(template: string, vars: TemplateVars): string {
  let tree: unknown;
  try {
    tree = JSON.parse(template);
  } catch {
    throw new TemplateError("The body template is not valid JSON.");
  }
  if (tree === null || typeof tree !== "object") throw new TemplateError("The body template must be a JSON object or list.");
  const out = JSON.stringify(fill(tree, vars));
  let back: unknown;
  try {
    back = JSON.parse(out);
  } catch {
    throw new TemplateError("The body template did not produce valid JSON.");
  }
  if (JSON.stringify(shape(back)) !== JSON.stringify(shape(tree))) throw new TemplateError("The body template changed shape when filled in.");
  return out;
}
