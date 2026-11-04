// Model references to loaded glTFs. Kit code must not import from src/ at runtime, so the key format of src/shared/scene3d/resolver.ts is repeated here.
import type { ModelRef } from "../../../src/shared/scene3d/resolver";

export const modelKeyOf = (ref: ModelRef): string => ("catalog" in ref ? `catalog:${ref.catalog}` : `file:${ref.file}`);

const SAFE_FILE = /^(assets3d\/files|models)\/[A-Za-z0-9_\-./]+\.glb$/;
/** Default URL for a reference when the host gave no table: local files only (through the public dir); catalogue ids need the host's table. */
export const defaultModelUrl = (ref: ModelRef, toUrl: (rel: string) => string): string | null =>
  "file" in ref && SAFE_FILE.test(ref.file) && !ref.file.split("/").some((p) => p === ".." || p === ".") ? toUrl(ref.file) : null;
