import { z } from "zod";
import { base, copy, LIMITS } from "./common";

export const schema = z
  .object({
    ...base,
    kind: z.literal("pause_card"),
    question: copy(LIMITS.pauseQuestion),
    options: z
      .array(copy(LIMITS.pauseOption))
      .min(LIMITS.pauseMinOptions)
      .max(LIMITS.pauseMaxOptions, `must have at most ${LIMITS.pauseMaxOptions} options`),
    answer: z.number().int().min(0), // 0-based index of the right option
    revealAtMs: z.number().int().min(0), // when the answer is shown, from the start of this scene
  })
  .superRefine((s, ctx) => {
    if (s.answer >= s.options.length) ctx.addIssue({ code: "custom", path: ["answer"], message: `must be an option index 0-${s.options.length - 1}` });
    if (s.revealAtMs >= s.durationMs) ctx.addIssue({ code: "custom", path: ["revealAtMs"], message: "must be earlier than durationMs" });
  });

export const describe = `kind "pause_card": quiz. question (max ${LIMITS.pauseQuestion}), options[] ${LIMITS.pauseMinOptions}-${LIMITS.pauseMaxOptions} short strings (max ${LIMITS.pauseOption} each), answer (0-based option index), revealAtMs (ms into the scene, less than durationMs).`;
