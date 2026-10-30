import { z } from "zod";
import { base, copy, LIMITS } from "./common";

const body = z.object({
  label: copy(LIMITS.orbitLabel),
  // Relative ring size, not pixels; the renderer scales it to fit the safe area.
  radius: z.number().min(1, "must be between 1 and 10").max(LIMITS.orbitRadiusMax, "must be between 1 and 10"),
  periodS: z
    .number()
    .min(LIMITS.orbitPeriodMin, `must be between ${LIMITS.orbitPeriodMin} and ${LIMITS.orbitPeriodMax}`)
    .max(LIMITS.orbitPeriodMax, `must be between ${LIMITS.orbitPeriodMin} and ${LIMITS.orbitPeriodMax}`),
});

export const schema = z
  .object({
    ...base,
    kind: z.literal("orbit"),
    title: copy(LIMITS.title).optional(),
    preset: z.enum(["solar_system", "moon_earth", "custom"]).default("solar_system"),
    center: copy(LIMITS.orbitLabel).optional(),
    bodies: z.array(body).min(1).max(LIMITS.orbitBodies, `must have at most ${LIMITS.orbitBodies} bodies`).optional(),
  })
  .refine((s) => s.preset !== "custom" || (s.bodies?.length ?? 0) > 0, {
    path: ["bodies"],
    message: 'is required when preset is "custom"',
  });

export const describe = `kind "orbit": preset "solar_system"|"moon_earth"|"custom" (default solar_system; presets ignore bodies); for custom, bodies[] (1-${LIMITS.orbitBodies}) each {label (max ${LIMITS.orbitLabel}), radius 1-${LIMITS.orbitRadiusMax} (relative ring size), periodS ${LIMITS.orbitPeriodMin}-${LIMITS.orbitPeriodMax} (seconds per lap)}; optional center label (max ${LIMITS.orbitLabel}), optional title (max ${LIMITS.title}).`;
