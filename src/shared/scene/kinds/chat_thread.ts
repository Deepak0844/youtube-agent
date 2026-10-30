import { z } from "zod";
import { base, copy, LIMITS } from "./common";

export const schema = z.object({
  ...base,
  kind: z.literal("chat_thread"),
  messages: z
    .array(z.object({ from: z.enum(["user", "assistant"]), text: copy(LIMITS.chatText) }))
    .min(1)
    .max(LIMITS.chatMessages, `must have at most ${LIMITS.chatMessages} messages`),
  // Sliding context window: only the newest N messages stay on screen, older ones fade out. Omit = keep all.
  windowSize: z.number().int().min(2, "must be at least 2").max(LIMITS.chatMessages, `must be at most ${LIMITS.chatMessages}`).optional(),
});

export const describe = `kind "chat_thread": messages[] (max ${LIMITS.chatMessages}), each {from: "user"|"assistant", text (max ${LIMITS.chatText})}, optional windowSize 2-${LIMITS.chatMessages} (only the newest N messages stay visible, older fade out).`;
