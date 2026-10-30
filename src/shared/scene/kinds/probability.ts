import { z } from "zod";
import { base, copy, LIMITS } from "./common";

export const schema = z
  .object({
    ...base,
    kind: z.literal("probability"),
    experiment: z.enum(["coin", "dice", "cards", "urn"]),
    title: copy(LIMITS.title).optional(),
    trials: z
      .number()
      .int("must be a whole number")
      .min(1, "must be at least 1")
      .max(LIMITS.probTrials, `must be at most ${LIMITS.probTrials}`),
    // Final tallies. The bars count up from 0 to these during the scene.
    outcomes: z
      .array(
        z.object({
          label: copy(LIMITS.probLabel),
          count: z.number().int("must be a whole number").min(0, "must be 0 or more").max(LIMITS.probTrials, `must be at most ${LIMITS.probTrials}`),
          p: z.number().min(0, "must be between 0 and 1").max(1, "must be between 0 and 1").optional(), // theoretical chance
        }),
      )
      .min(2, "must have at least 2 outcomes")
      .max(LIMITS.probOutcomes, `must have at most ${LIMITS.probOutcomes} outcomes`),
  })
  .superRefine((s, ctx) => {
    const sum = s.outcomes.reduce((a, o) => a + o.count, 0);
    if (sum !== s.trials) ctx.addIssue({ code: "custom", path: ["outcomes"], message: `counts add up to ${sum} but trials is ${s.trials}` });
  });

export const describe = `kind "probability": experiment "coin"|"dice"|"cards"|"urn", trials (whole number 1-${LIMITS.probTrials}), outcomes[] (2-${LIMITS.probOutcomes}), each {label (max ${LIMITS.probLabel}), count (whole number, 0 up to trials), p (optional chance 0-1)}; counts MUST add up to trials; optional title (max ${LIMITS.title}).`;
