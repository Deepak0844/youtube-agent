// How a model reference in a scene turns into a loadable file. Slice A's catalogue plugs in with a resolver of its own;
// until then local files under assets3d/files/ (or the kit's models/ folder) are accepted.
export type ModelRef = { catalog: string } | { file: string };
export type ResolvedModel = { url: string };
export interface ModelResolver {
  /** Returns null when the reference cannot be resolved (the scene then shows a plain stand-in and the validator says so). */
  resolve(ref: ModelRef): ResolvedModel | null;
}

export const modelKey = (ref: ModelRef): string => ("catalog" in ref ? `catalog:${ref.catalog}` : `file:${ref.file}`);

const SAFE_FILE = /^(assets3d\/files|models)\/[A-Za-z0-9_\-./]+\.glb$/;
/** Only .glb files under assets3d/files/ or models/, never a parent path. */
export const isSafeModelFile = (f: string): boolean => SAFE_FILE.test(f) && !f.split("/").some((p) => p === ".." || p === "." || p === "");

/** Resolver for local files. `toUrl` maps a safe relative path to a URL (staticFile in a render, a path in tests). */
export function fileResolver(toUrl: (relPath: string) => string = (p) => p): ModelResolver {
  return { resolve: (ref) => ("file" in ref && isSafeModelFile(ref.file) ? { url: toUrl(ref.file) } : null) };
}

/** Tries each resolver in order. */
export function chainResolvers(...rs: ModelResolver[]): ModelResolver {
  return { resolve: (ref) => rs.reduce<ResolvedModel | null>((found, r) => found ?? r.resolve(ref), null) };
}

/** A resolver backed by a fixed table of catalogue ids (what slice D will build from the catalogue). */
export function catalogResolver(table: Record<string, string>): ModelResolver {
  return { resolve: (ref) => ("catalog" in ref && Object.hasOwn(table, ref.catalog) ? { url: table[ref.catalog]! } : null) };
}
