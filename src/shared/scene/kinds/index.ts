// HOW TO ADD A SCENE KIND
// 1. Add src/shared/scene/kinds/<kind>.ts exporting `schema` (zod object with kind: z.literal("<kind>"))
//    and `describe` (one prompt line for describeSceneFormat). Import helpers from ./common.
// 2. Add ONE line below: an import and one entry in `kinds`, both alphabetical by kind.
// 3. Add the Remotion component in remotion/kit/<Kind>.tsx and its entry in remotion/kit/registry.tsx.
import * as browser from "./browser";
import * as algo_cells from "./algo_cells";
import * as chat_thread from "./chat_thread";
import * as pause_card from "./pause_card";
import * as stock_clip from "./stock_clip";
import * as drawn_objects from "./drawn_objects";
import * as network from "./network";
import * as math from "./math";
import * as probability from "./probability";
import * as chart from "./chart";
import * as spreadsheet from "./spreadsheet";
import * as collage from "./collage";
import * as chess from "./chess";
import * as piano from "./piano";
import * as story_kenburns from "./story_kenburns";
import * as terminal from "./terminal";

export const kinds = {
  browser,
  algo_cells,
  chat_thread,
  pause_card,
  stock_clip,
  drawn_objects,
  network,
  math,
  probability,
  chart,
  spreadsheet,
  collage,
  chess,
  piano,
  story_kenburns,
  terminal,
};
