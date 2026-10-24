import { describe, expect, it } from "vitest";
import { assertFfprobeAvailable } from "../support/tools";

describe("host tool precheck", () => {
  it("ffprobe_missing_fails_loudly_naming_the_fix", () => {
    expect(() => assertFfprobeAvailable({ ...process.env, PATH: "" })).toThrow(
      "ffprobe not found on PATH. Install ffmpeg and retry.",
    );
  });
});
