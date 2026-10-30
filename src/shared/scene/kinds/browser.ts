import { z } from "zod";
import { assetId, base, copy, LIMITS } from "./common";

// A mock browser window: text only. The url is just a label that is drawn, never fetched.
const block = z.discriminatedUnion("type", [
  z.object({ type: z.literal("heading"), text: copy(LIMITS.browserText) }),
  z.object({ type: z.literal("text"), text: copy(LIMITS.browserText) }),
  z.object({ type: z.literal("image"), asset: assetId }),
]);

export const schema = z.object({
  ...base,
  kind: z.literal("browser"),
  title: copy(LIMITS.browserTitle),
  url: copy(LIMITS.browserUrl),
  blocks: z
    .array(block)
    .min(1)
    .max(
      LIMITS.browserBlocks,
      `must have at most ${LIMITS.browserBlocks} blocks`,
    ),
});

export const describe = `kind "browser": title (max ${LIMITS.browserTitle}), url (label only, max ${LIMITS.browserUrl}), blocks[] (max ${LIMITS.browserBlocks}), each {type: "heading"|"text", text (max ${LIMITS.browserText})} or {type: "image", asset (asset id)}. Blocks appear one by one.`;
