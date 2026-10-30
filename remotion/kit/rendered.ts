// Scene kinds KitScene has a `case` for. tests/unit/kit-scene.test.ts compares this with the schema registry,
// so adding a kind to src/shared/scene/kinds without a case here fails the test. Keep alphabetical-free: just add the name.
export const KIT_RENDERED_KINDS = [
  "algo_cells",
  "browser",
  "chart",
  "chat_thread",
  "chess",
  "collage",
  "drawn_objects",
  "map",
  "math",
  "network",
  "orbit",
  "pause_card",
  "piano",
  "probability",
  "spreadsheet",
  "stock_clip",
  "story_kenburns",
  "terminal",
] as const;
export type RenderedKind = (typeof KIT_RENDERED_KINDS)[number];
