import { describe, expect, it } from "vitest";
import { CLIP_MAX_BYTES, rankClips, scoreClip, wantsMotion, type ClipCandidate } from "@/server/core/clip-rank";
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
    expect(clipProbeOk({ ...ok, format: { duration: "40" } }).ok).toBe(false);
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
