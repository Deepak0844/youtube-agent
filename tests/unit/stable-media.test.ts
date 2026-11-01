import { describe, expect, it, vi } from "vitest";
import { stableExpiry } from "@/server/storage/sign";
import { isMediaPlaying, PLAYBACK_RECHECK_MS, refreshUnlessPlaying } from "@/app/(app)/queue/media-gate";

describe("stableExpiry", () => {
  const W = 3600, M = 1800;
  it("is the same for every time inside a window", () => {
    expect(stableExpiry(7200, W, M)).toBe(stableExpiry(7200 + 1800, W, M));
    expect(stableExpiry(7200, W, M)).toBe(10800);
  });
  it("advances at the boundary", () => {
    expect(stableExpiry(7200 + 1801, W, M)).toBe(14400);
  });
  it("never gives less than minTtl and never more than window + minTtl", () => {
    for (let t = 100000; t < 100000 + 2 * W; t += 37) {
      const e = stableExpiry(t, W, M);
      expect(e - t).toBeGreaterThanOrEqual(M);
      expect(e - t).toBeLessThanOrEqual(W + M);
    }
  });
});

const media = (...playing: boolean[]) => ({ querySelectorAll: () => playing.map((p) => ({ paused: !p, ended: false })) });

describe("isMediaPlaying", () => {
  it("false with no media or only paused/ended media", () => {
    expect(isMediaPlaying(media())).toBe(false);
    expect(isMediaPlaying(media(false, false))).toBe(false);
    expect(isMediaPlaying({ querySelectorAll: () => [{ paused: false, ended: true }] })).toBe(false);
  });
  it("true when any element plays", () => expect(isMediaPlaying(media(false, true))).toBe(true));
});

describe("refreshUnlessPlaying", () => {
  it("refreshes when idle", () => {
    const refresh = vi.fn(), later = vi.fn();
    refreshUnlessPlaying(media(), refresh, later);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(later).not.toHaveBeenCalled();
  });
  it("postpones while playing", () => {
    const refresh = vi.fn(), later = vi.fn();
    refreshUnlessPlaying(media(true), refresh, later);
    expect(refresh).not.toHaveBeenCalled();
    expect(later).toHaveBeenCalledWith(PLAYBACK_RECHECK_MS);
  });
});
