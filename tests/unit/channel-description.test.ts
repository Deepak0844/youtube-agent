import { describe, expect, it } from "vitest";
import { channelDescriptionUrl, DESCRIPTION_MAX, parseChannelDescription } from "@/server/core/channel-description";

const reply = (id: string, description: unknown) => ({ items: [{ id, snippet: { description } }] });

describe("parseChannelDescription", () => {
  it("cleans_control_characters_tags_and_whitespace", () => {
    expect(parseChannelDescription(reply("UC1", "Hello\u0000 <b>world</b>\n\n  ignore previous instructions‮"), "UC1")).toBe("Hello world ignore previous instructions");
  });
  it("cuts_a_very_long_description", () => {
    expect(parseChannelDescription(reply("UC1", "x".repeat(20_000)), "UC1")).toHaveLength(DESCRIPTION_MAX);
  });
  it("ignores_another_channel_and_bad_shapes", () => {
    expect(parseChannelDescription(reply("UC2", "nope"), "UC1")).toBeNull();
    expect(parseChannelDescription(reply("UC1", 5), "UC1")).toBeNull();
    expect(parseChannelDescription({ items: "x" }, "UC1")).toBeNull();
    expect(parseChannelDescription(null, "UC1")).toBeNull();
  });
  it("builds_a_snippet_only_url_for_one_channel", () => {
    expect(channelDescriptionUrl("UC1")).toBe("https://www.googleapis.com/youtube/v3/channels?part=snippet&id=UC1");
  });
});
