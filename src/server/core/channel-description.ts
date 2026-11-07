import { cleanText } from "./ideas";

// A channel's description, read from YouTube (channels.list part=snippet). Untrusted text: cleaned and cut here, stored as data,
// and only ever put into a prompt inside a fenced DATA block.

export const DESCRIPTION_MAX = 5000;

/** The description of channel `channelId` from a channels.list reply; null when the reply has no such channel or no text field. */
export function parseChannelDescription(body: unknown, channelId: string): string | null {
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return null;
  for (const it of items as Array<{ id?: unknown; snippet?: { description?: unknown } }>) {
    if (it?.id === channelId && typeof it.snippet?.description === "string") return cleanText(it.snippet.description.replace(/<[^>]*>/g, ""), DESCRIPTION_MAX);
  }
  return null;
}

export const channelDescriptionUrl = (channelId: string): string =>
  `https://www.googleapis.com/youtube/v3/channels?part=snippet&id=${encodeURIComponent(channelId)}`;
