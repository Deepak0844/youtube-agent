/** Contact-sheet HTML: one captioned cell per id, `cols` columns, 270px-wide thumbnails (9:16). */
export function sheetHtml(ids, cols = 6) {
  const cells = ids.map((id) => `<figure><img src="${id}.png"><figcaption>${id}</figcaption></figure>`).join("");
  return `<!doctype html><meta charset="utf-8"><style>body{margin:0;padding:12px;background:#111;font:14px monospace;color:#eee;width:${cols * 290}px}main{display:grid;grid-template-columns:repeat(${cols},270px);gap:20px}figure{margin:0}img{width:270px;height:480px;display:block;background:#333}figcaption{padding-top:4px}</style><main>${cells}</main>`;
}

/** Composition ids from the registry source text. */
export function registryIds(src) {
  return [...src.matchAll(/\{ id: "(kit-[a-z0-9-]+)", component:/g)].map((m) => m[1]);
}
