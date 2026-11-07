import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  SEARCH_DAILY_MAX, canSearch, isoDurationSeconds, outliers, parseChannels, parseHnItem, parseSearchChannelIds, parseVideos, parseWikimediaTop,
  parseChannelRef, scoreCandidate, uploadsPlaylistId, words, wikimediaUrl,
} from "@/server/core/research";

const fx = (n: string): unknown => JSON.parse(readFileSync(`tests/fixtures/research/${n}`, "utf8"));
const NOW = new Date("2026-11-07T00:00:00Z");

describe("search cap", () => {
  it("stops_at_90_a_day", () => {
    expect(SEARCH_DAILY_MAX).toBe(90);
    expect(canSearch(0)).toBe(true);
    expect(canSearch(89)).toBe(true);
    expect(canSearch(90)).toBe(false);
    expect(canSearch(250)).toBe(false);
  });
});

describe("parsing YouTube answers", () => {
  it("channels_keep_valid_ids_and_numbers_only", () => {
    expect(parseChannels(fx("channels.json"))).toEqual([
      { id: "UCaaaaaaaaaaaaaaaaaaaaaa", title: "Rust Explained", description: "Rust programming explained in shorts", language: "en", subs: 5400 },
      { id: "UCbbbbbbbbbbbbbbbbbbbbbb", title: "Cooking Daily", description: "recipes", language: "", subs: 900000 },
    ]);
  });
  it("videos_skip_items_without_a_channel_or_stats", () => {
    const v = parseVideos(fx("videos.json"));
    expect(v.map((x) => x.videoId)).toEqual(["vid00000001", "vid00000002"]);
    expect(v[0]).toMatchObject({ views: 90000, durationS: 45, tags: ["rust", "memory"] });
    expect(v[1]!.durationS).toBe(62);
  });
  it("garbage_gives_empty_lists", () => {
    for (const bad of [null, "x", { items: 5 }, []]) {
      expect(parseChannels(bad)).toEqual([]);
      expect(parseVideos(bad)).toEqual([]);
      expect(parseSearchChannelIds(bad)).toEqual([]);
    }
  });
  it("search_results_give_channel_ids", () => {
    expect(parseSearchChannelIds({ items: [{ snippet: { channelId: "UCaaaaaaaaaaaaaaaaaaaaaa" } }, { snippet: { channelId: "no way" } }, {}] })).toEqual(["UCaaaaaaaaaaaaaaaaaaaaaa"]);
  });
  it("uploads_playlist_swaps_the_prefix", () => {
    expect(uploadsPlaylistId("UCabc")).toBe("UUabc");
    expect(uploadsPlaylistId("xyz")).toBeNull();
  });
  it("iso_durations", () => {
    expect(isoDurationSeconds("PT1H2M3S")).toBe(3723);
    expect(isoDurationSeconds("nope")).toBe(0);
  });
});

describe("scoring", () => {
  const profile = { language: "en", keywords: ["rust", "memory", "programming"] };
  const base = { id: "UCaaaaaaaaaaaaaaaaaaaaaa", title: "Rust Explained", description: "Rust programming and memory", language: "en", subs: 5400 };
  const recent = [1, 2, 3, 4].map((i) => ({ videoId: `v${i}`, channelId: "x", title: "t", tags: [], publishedAt: new Date(NOW.getTime() - i * 86400_000), views: 1, durationS: 40 }));
  it("a_close_active_short_form_channel_scores_high_with_reasons", () => {
    const s = scoreCandidate(base, profile, 1000, recent, NOW);
    expect(s.score).toBe(100);
    expect(s.reason).toContain("topic overlap 3");
  });
  it("off_topic_never_passes_whatever_its_size", () => {
    const s = scoreCandidate({ ...base, title: "Cooking", description: "recipes" }, profile, 1000, recent, NOW);
    expect(s.score).toBeLessThanOrEqual(20);
  });
  it("wrong_language_and_huge_size_lose_points", () => {
    const s = scoreCandidate({ ...base, language: "fr", subs: 9_000_000 }, profile, 1000, recent, NOW);
    expect(s.score).toBe(65);
    expect(s.reason).toContain("language fr");
    expect(s.reason).toContain("outside your size band");
  });
  it("words_drop_stop_words", () => expect(words("The Rust and the memory")).toEqual(["rust", "memory"]));
});

describe("outliers (median multiple and age)", () => {
  const vid = (id: string, views: number, ageDays: number) => ({ videoId: id, competitorId: "c1", title: id, publishedAt: new Date(NOW.getTime() - ageDays * 86400_000), views });
  const four = [vid("a", 100, 30), vid("b", 100, 30), vid("c", 100, 30), vid("d", 100, 30)];
  it("flags_young_videos_at_3x_the_channel_median", () => {
    const r = outliers([...four, vid("hit", 450, 3)], NOW);
    expect(r).toEqual([{ videoId: "hit", competitorId: "c1", title: "hit", views: 450, xMedian: 4.5, ageDays: 3 }]);
  });
  it("ignores_old_hits_and_small_samples", () => {
    expect(outliers([...four, vid("old", 900, 40)], NOW)).toEqual([]);
    expect(outliers([vid("a", 100, 30), vid("hit", 900, 1)], NOW)).toEqual([]);
  });
  it("sorts_by_multiple_and_keeps_channels_apart", () => {
    const other = ["p", "q", "r", "s"].map((i) => ({ ...vid(i, 10, 20), competitorId: "c2" }));
    const r = outliers([...four, vid("h1", 300, 2), ...other, { ...vid("h2", 500, 2), competitorId: "c2" }], NOW);
    expect(r.map((x) => x.videoId)).toEqual(["h2", "h1"]);
  });
});

describe("trend sources (untrusted text)", () => {
  it("hacker_news_item_becomes_plain_text_with_our_own_link", () => {
    const t = parseHnItem(fx("hn-item.json"), 123)!;
    expect(t).toMatchObject({ source: "hackernews", signal: 321, url: "https://news.ycombinator.com/item?id=123", itemKey: "123" });
    expect(t.topic).not.toContain("<");
  });
  it("hacker_news_rejects_items_without_a_title", () => expect(parseHnItem({ id: 1 }, 1)).toBeNull());
  it("wikimedia_drops_meta_pages_and_builds_wikipedia_links", () => {
    const r = parseWikimediaTop(fx("wikimedia-top.json"), 10);
    expect(r.map((x) => x.topic)).toEqual(["Voyager 1", "Alan Turing"]);
    expect(r[0]).toMatchObject({ source: "wikimedia", signal: 250000, url: "https://en.wikipedia.org/wiki/Voyager_1" });
  });
  it("wikimedia_url_uses_the_day_before_in_utc", () => {
    expect(wikimediaUrl(new Date("2026-11-07T01:00:00Z"))).toBe("https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access/2026/11/06");
  });
});

describe("add by handle or id", () => {
  it("accepts_a_handle_or_a_channel_id_and_nothing_else", () => {
    expect(parseChannelRef(" @rustexplained ")).toEqual({ kind: "handle", handle: "@rustexplained" });
    expect(parseChannelRef("UCrustrustrustrustrust01")).toEqual({ kind: "id", id: "UCrustrustrustrustrust01" });
    for (const bad of ["rustexplained", "@a", "https://youtube.com/@x", "@x y z", "UCshort"]) expect(parseChannelRef(bad), bad).toBeNull();
  });
});
