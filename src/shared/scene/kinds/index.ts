// HOW TO ADD A SCENE KIND
// 1. Add src/shared/scene/kinds/<kind>.ts exporting `schema` (zod object with kind: z.literal("<kind>"))
//    and `describe` (one prompt line for describeSceneFormat). Import helpers from ./common.
// 2. Add ONE line below: an import and one entry in `kinds`, both alphabetical by kind.
// 3. Add the Remotion component in remotion/kit/<Kind>.tsx and its entry in remotion/kit/registry.tsx.
import * as chat_thread from "./chat_thread";
import * as map from "./map";
import * as orbit from "./orbit";
import * as story_kenburns from "./story_kenburns";
import * as terminal from "./terminal";

export const kinds = {
  chat_thread,
  map,
  orbit,
  story_kenburns,
  terminal,
};
