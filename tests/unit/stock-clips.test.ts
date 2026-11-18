import { describe, expect, it } from "vitest";
import { CLIPS_TOTAL_MAX_BYTES, CLIP_MAX_BYTES, clipBudget, countClipLinks, rankClips, scoreClip, wantsMotion, type ClipCandidate } from "@/server/core/clip-rank";
import { checkPictureIds, limitRepeats, planPictureBeat } from "@/server/core/scene-build";
import { chooseRendition, parsePixabayVideos, pixabayVideoSearchUrl } from "@/server/providers/stock/pixabay-videos";
import { clipProbeOk } from "@/server/render/ingest";

const f = (h: number, size: number, host = "cdn.pixabay.com", ext = "mp4") => ({ url: `https://${host}/video/a_${h}.${ext}`, width: Math.round((h * 16) / 9), height: h, size });
const brief = { search: ["ocean waves"], visual: "ocean waves rolling onto a beach" };
const clip = (o: Partial<ClipCandidate> = {}): ClipCandidate => ({ title: "ocean waves beach", url: "https://cdn.pixabay.com/v.mp4", width: 1920, height: 1080, durationS: 10, bytes: 8e6, licence: "Pixabay Content License", credit: "c", pageUrl: null, text: "ocean waves beach", ...o });

describe("chooseRendition", () => {
  it("takes the smallest file with height >= 720", () => {
    const r = chooseRendition({ large: f(1080, 20e6), medium: f(720, 9e6), small: f(360, 2e6), tiny: f(180, 1e6) });
    expect(r?.height).toBe(720);
  });
  it("skips files over the size cap, off-list hosts, non-mp4 and unknown size", () => {
    expect(chooseRendition({ large: f(1080, CLIP_MAX_BYTES + 1) })).toBeNull();
    expect(chooseRendition({ large: f(1080, 5e6, "player.vimeo.com") })).toBeNull();
    expect(chooseRendition({ large: f(1080, 5e6, "cdn.pixabay.com", "webm") })).toBeNull();
    expect(chooseRendition({ large: { ...f(1080, 5e6), size: 0 } })).toBeNull();
  });
});

describe("parsePixabayVideos and search url", () => {
  it("parses a hit, stamps licence and credit", () => {
    const [c] = parsePixabayVideos({ hits: [{ id: 1, tags: "ocean, waves", user: "bob", duration: 12, pageURL: "https://pixabay.com/videos/x-1/", videos: { medium: f(720, 5e6) } }] });
    expect(c).toMatchObject({ licence: "Pixabay Content License", durationS: 12, text: "ocean waves" });
    expect(c!.credit).toContain("bob");
  });
  it("drops hits with no usable rendition and bad json", () => {
    expect(parsePixabayVideos({ hits: [{ duration: 9, videos: { large: f(1080, 99e6) } }] })).toEqual([]);
    expect(parsePixabayVideos(null)).toEqual([]);
  });
  it("uses the videos endpoint on pixabay.com", () => expect(pixabayVideoSearchUrl("a b", "K", 12)).toMatch(/^https:\/\/pixabay\.com\/api\/videos\/\?/));
});

describe("clip ranking", () => {
  it("rejects wrong length, oversize and low height", () => {
    expect(scoreClip(brief, clip({ durationS: 3 }))).toBeNull();
    expect(scoreClip(brief, clip({ durationS: 25 }))).toBeNull();
    expect(scoreClip(brief, clip({ bytes: CLIP_MAX_BYTES + 1 }))).toBeNull();
    expect(scoreClip(brief, clip({ height: 480 }))).toBeNull();
  });
  it("ranks the better tag match first and drops weak matches", () => {
    const r = rankClips(brief, [clip({ title: "cat", text: "cat" }), clip({ title: "waves", text: "waves" }), clip()]);
    expect(r.map((x) => x.cand.title)).toEqual(["ocean waves beach"]);
  });
});

describe("wantsMotion", () => {
  it("true for motion, false for diagrams and stills", () => {
    expect(wantsMotion("waves rolling onto a beach")).toBe(true);
    expect(wantsMotion("diagram of a flowing river system")).toBe(false);
    expect(wantsMotion("a lighthouse")).toBe(false);
  });
});

describe("clipProbeOk", () => {
  const v = { codec_type: "video", codec_name: "h264", width: 1080, height: 1920 };
  const ok = { streams: [v, { codec_type: "audio" }], format: { duration: "10.2" } };
  it("accepts a plain h264 clip", () => expect(clipProbeOk(ok)).toMatchObject({ ok: true, durationS: 10.2 }));
  it("refuses other codecs, long, short, huge and extra video streams", () => {
    expect(clipProbeOk({ ...ok, streams: [{ ...v, codec_name: "vp9" }] }).ok).toBe(false);
    expect(clipProbeOk({ ...ok, format: { duration: "90" } }).ok).toBe(false);
    expect(clipProbeOk({ ...ok, format: { duration: "45" } }).ok).toBe(true); // a montage trims a longer clip
    expect(clipProbeOk({ ...ok, format: { duration: "2" } }).ok).toBe(false);
    expect(clipProbeOk({ ...ok, streams: [{ ...v, width: 9000 }] }).ok).toBe(false);
    expect(clipProbeOk({ ...ok, streams: [v, v] }).ok).toBe(false);
  });
});

describe("build planning with clips", () => {
  const A = "11111111-1111-4111-8111-111111111111";
  const B = "22222222-2222-4222-8222-222222222222";
  it("a linked clip makes a stock_clip scene with that single id", () => {
    expect(planPictureBeat([A, B], new Set([B]))).toEqual({ kind: "stock_clip", assets: [B] });
    expect(planPictureBeat([A], new Set())).toEqual({ kind: "story_kenburns", assets: [A] });
  });
  it("checks the clip id and counts clips in the repeat rule", () => {
    expect(checkPictureIds({ kind: "stock_clip", asset: B }, [B])).toEqual([]);
    expect(checkPictureIds({ kind: "stock_clip", asset: A }, [B])).toHaveLength(1);
    expect(limitRepeats([[B], [B], [B], [A]])).toEqual([[B], [B], [], [A]]);
  });
});

describe("clip budgets", () => {
  it("caps each download by what is left of the run budget and stops below one clip", () => {
    expect(clipBudget(0)).toBe(CLIP_MAX_BYTES);
    expect(clipBudget(CLIPS_TOTAL_MAX_BYTES - CLIP_MAX_BYTES)).toBe(CLIP_MAX_BYTES);
    expect(clipBudget(CLIPS_TOTAL_MAX_BYTES - CLIP_MAX_BYTES + 1)).toBe(0);
    expect(clipBudget(CLIPS_TOTAL_MAX_BYTES)).toBe(0);
  });
  it("counts clip links on every live beat, not only kept ones", () => {
    const links = [{ beatId: "a", kind: "video" }, { beatId: "b", kind: "video" }, { beatId: "b", kind: "image" }, { beatId: "gone", kind: "video" }];
    expect(countClipLinks(links, new Set(["a", "b"]))).toBe(2);
    expect(countClipLinks([], new Set(["a"]))).toBe(0);
  });
});

describe("rankClipsByPhrase (montage)", () => {
  const cand = (url: string, title: string, text: string) => ({ title, url, width: 1920, height: 1080, durationS: 9, bytes: 3e6, licence: "Pixabay Content License", credit: "c", pageUrl: null, text });
  it("scores a clip against the phrase that found it, so a long picture sentence cannot sink it, and keeps each clip once, best first", async () => {
    const { rankClipsByPhrase } = await import("@/server/core/clip-rank");
    const a = cand("https://x/a.mp4", "night train railway", "train, night, travel");
    const b = cand("https://x/b.mp4", "dark countryside field", "countryside, dark");
    const r = rankClipsByPhrase([{ phrase: "night train window", cands: [a, b] }, { phrase: "dark countryside train", cands: [a, b] }]);
    expect(r.map((x) => x.cand.url)).toEqual(["https://x/a.mp4", "https://x/b.mp4"]);
    expect(r.every((x) => x.score >= 0.35)).toBe(true);
    expect(rankClipsByPhrase([{ phrase: "ocean waves", cands: [a] }])).toEqual([]);
  });
});

describe("montage takes longer clips", () => {
  it("a 45 s clip is refused by default and taken by a montage (which trims from the middle)", async () => {
    const { rankClips, rankClipsByPhrase, MONTAGE_CLIP_MAX_SECONDS } = await import("@/server/core/clip-rank");
    const long = { title: "dark sleeper cabin night", url: "https://x/l.mp4", width: 1280, height: 720, durationS: 45, bytes: 9e6, licence: "Pixabay Content License", credit: "c", pageUrl: null, text: "cabin, dark, night" };
    expect(rankClips({ search: ["dark sleeper cabin"], visual: "" }, [long])).toEqual([]);
    expect(rankClipsByPhrase([{ phrase: "dark sleeper cabin", cands: [long] }]).length).toBe(1);
    expect(rankClipsByPhrase([{ phrase: "dark sleeper cabin", cands: [{ ...long, durationS: MONTAGE_CLIP_MAX_SECONDS + 1 }] }])).toEqual([]);
  });
});

describe("montage clips must show the subject", () => {
  const c = (title: string, text: string, url: string) => ({ title, url, width: 1920, height: 1080, durationS: 12, bytes: 3e6, licence: "Pixabay Content License", credit: "c", pageUrl: null, text });
  it("a moon clip tagged night is refused for 'night train window'; a train clip is taken", async () => {
    const { rankClipsByPhrase, subjectWords, showsSubject } = await import("@/server/core/clip-rank");
    expect(subjectWords("night train window")).toEqual(["train", "window"]);
    expect(subjectWords("dark night")).toEqual([]);
    const moon = c("moon moonlight night full moon", "night, moon, dark, window", "https://x/moon.mp4");
    const train = c("train night city lights window view", "train, window, travel", "https://x/train.mp4");
    const r = rankClipsByPhrase([{ phrase: "night train window", cands: [moon, train] }]);
    expect(r.map((x) => x.cand.url)).toEqual(["https://x/train.mp4"]);
    const ai = c("ai generated rain train window", "anime lofi train window", "https://x/ai.mp4");
    expect(rankClipsByPhrase([{ phrase: "rain train window", cands: [ai] }])).toEqual([]); // drawn or AI-made clips are not real footage
    expect(showsSubject([], moon)).toBe(true); // a phrase of only mood words has no rule
    expect(showsSubject(["sleeper", "cabin"], c("log cabin night", "cabin, forest", "u"))).toBe(false); // the main subject (sleeper) is needed, not just cabin
    expect(showsSubject(["sleeper", "cabin"], c("sleeper train cabin", "", "u"))).toBe(true);
  });
});
