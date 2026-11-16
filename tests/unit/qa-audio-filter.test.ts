import { describe, expect, it } from "vitest";
import { AUDIO_QA_FILTER } from "@/server/render/qa-scan";

// ffmpeg 5.1 (Debian stable, so the app image and many VPSs) fails the whole QA scan with "Error reinitializing filters!" when
// ebur128 is given framelog=quiet; newer ffmpeg accepts it. framelog=verbose works on both and still keeps the per-frame lines out of
// the output (they only show at ffmpeg's verbose level), so the summary the parser reads is the same. Checked on 5.1.9 and 9.0.2.
describe("QA loudness filter", () => {
  it("never uses framelog=quiet", () => expect(AUDIO_QA_FILTER).not.toContain("framelog=quiet"));
  it("measures integrated loudness and true peak, then volume", () => expect(AUDIO_QA_FILTER).toBe("ebur128=peak=true:framelog=verbose,volumedetect"));
});
