// Pure parts of `npm run kit:video`: arguments and props. Tested in tests/unit/kit-video.test.ts.
// buildVideoProps lives in src/shared/scene/video-props.ts so the render stage uses the same code.
export { buildVideoProps } from "../src/shared/scene/video-props";

export type VideoArgs = { file: string; audio?: string; captions?: string };

export function parseVideoArgs(argv: string[]): VideoArgs | { error: string } {
  const usage = { error: "usage: npm run kit:video -- <scenes.json> [--audio file.wav] [--captions captions.json]" };
  const a = argv.filter((x) => x !== "--");
  const out: Partial<VideoArgs> = {};
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    if (x === "--audio" || x === "--captions") {
      const v = a[++i];
      if (!v || v.startsWith("-")) return usage;
      out[x === "--audio" ? "audio" : "captions"] = v;
    } else if (x.startsWith("-") || out.file) return usage;
    else out.file = x;
  }
  return out.file ? (out as VideoArgs) : usage;
}
