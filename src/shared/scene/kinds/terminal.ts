import { z } from "zod";
import { base, copy, LIMITS } from "./common";

export const schema = z.object({
  ...base,
  kind: z.literal("terminal"),
  title: copy(LIMITS.title).optional(),
  lines: z
    .array(
      z.object({
        // Optional; missing or empty falls back to "$".
        prompt: z
          .string()
          .trim()
          .max(LIMITS.terminalPrompt, `must be at most ${LIMITS.terminalPrompt} characters`)
          .default("$")
          .transform((p) => p || "$"),
        text: copy(LIMITS.terminalText),
        output: z.boolean().default(false), // true = printed output, no typing
      }),
    )
    .min(1)
    .max(LIMITS.terminalLines, `must have at most ${LIMITS.terminalLines} lines`),
});

export const describe = `kind "terminal": lines[] (max ${LIMITS.terminalLines}), each {text (REQUIRED, max ${LIMITS.terminalText} characters per line; split longer text across lines), prompt (optional, max ${LIMITS.terminalPrompt} chars, default "$"; omit it rather than leave it empty), output (bool)}; optional title (max ${LIMITS.title}).`;
