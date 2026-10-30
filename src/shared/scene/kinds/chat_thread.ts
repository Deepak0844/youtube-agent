import { z } from "zod";
import { base, copy, LIMITS } from "./common";

export const schema = z.object({
  ...base,
  kind: z.literal("chat_thread"),
  messages: z
    .array(z.object({ from: z.enum(["user", "assistant"]), text: copy(LIMITS.chatText) }))
    .min(1)
    .max(LIMITS.chatMessages, `must have at most ${LIMITS.chatMessages} messages`),
});

export const describe = `kind "chat_thread": messages[] (max ${LIMITS.chatMessages}), each {from: "user"|"assistant", text (max ${LIMITS.chatText})}.`;
