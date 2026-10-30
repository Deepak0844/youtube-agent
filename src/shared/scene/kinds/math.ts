import { z } from "zod";
import { base, copy, LIMITS } from "./common";

// Plain-text maths only: letters, digits, spaces and a small operator set. No LaTeX, HTML or code.
const SAFE = /^[A-Za-z0-9 +\-−×÷*/=^().,≤≥≠≈√π%]+$/;

export const schema = z.object({
  ...base,
  kind: z.literal("math"),
  title: copy(LIMITS.title).optional(),
  // Shown top to bottom, one new line at a time.
  steps: z
    .array(
      z
        .object({
          text: copy(LIMITS.mathText).regex(SAFE, "may only use letters, digits, spaces and + - × ÷ * / = ^ ( ) . , ≤ ≥ ≠ ≈ √ π %"),
          highlight: copy(LIMITS.mathHighlight).optional(), // a piece of text to colour
        })
        .refine((s) => !s.highlight || s.text.includes(s.highlight), {
          path: ["highlight"],
          message: "must appear in the text of the same line",
        }),
    )
    .min(1)
    .max(LIMITS.mathSteps, `must have at most ${LIMITS.mathSteps} steps`),
});

export const describe = `kind "math": steps[] (max ${LIMITS.mathSteps}, shown in order), each {text (REQUIRED, max ${LIMITS.mathText} chars, plain text only: letters, digits, spaces and + - × ÷ * / = ^ ( ) . , ≤ ≥ ≠ ≈ √ π %; no LaTeX, no HTML), highlight (optional, max ${LIMITS.mathHighlight} chars, must be copied exactly from that line's text)}; optional title (max ${LIMITS.title}).`;
