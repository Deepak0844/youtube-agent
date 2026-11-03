import { z } from "zod";
import { STYLE_IDS } from "../../../remotion/kit/presets";

// Pure rules for the per-channel safety switches (Phase 5 slice 2). No IO. Fails closed.

export interface ChannelFacts {
  production: boolean;
  allowPublic: boolean;
}

/**
 * The first reason bytes may not leave for this channel, or null. `channel` is null for a channel id that is not a connected
 * channel row (nothing can be uploaded there anyway: there is no token). The kill switch and cutover are read from settings;
 * only a stored `false` counts as off, so an unreadable value refuses.
 */
export function channelUploadProblem(i: { killSwitch: unknown; cutoverDone: unknown; visibility: unknown; channel: ChannelFacts | null }): string | null {
  if (i.killSwitch !== false) return "uploads are switched off (kill switch)";
  if (i.channel === null) return null;
  if (i.visibility === "public" && !i.channel.allowPublic) return "public publishing is switched off for this channel; choose private or unlisted";
  if (i.channel.production && i.cutoverDone !== true) return "this is a production channel and the go-live cutover has not been done";
  return null;
}

export const CUTOVER_PHRASE = "GO LIVE";

const bool = z.boolean();
export const channelSettingsSchema = z
  .object({
    production: bool,
    allowPublic: bool,
    madeForKids: bool,
    synthetic: bool,
    maxUploadsPerDay: z.number().int().min(0).max(50),
    minHoursBetweenUploads: z.number().int().min(0).max(168),
    language: z.string().regex(/^([a-z]{2,3}(-[A-Za-z0-9]{2,8})?)?$/),
    categoryId: z.number().int().min(1).max(99),
    defaultStyle: z.enum(STYLE_IDS).nullable(),
  })
  .strict();
export type ChannelSettingsInput = z.infer<typeof channelSettingsSchema>;
