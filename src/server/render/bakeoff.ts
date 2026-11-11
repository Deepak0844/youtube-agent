import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { cheapest, gridArgs, gridProblem, labelLines, LABEL_HEIGHT, PANEL, type Panel } from "@/server/core/bakeoff";

const run = promisify(execFile);
const FONT = path.resolve("infra/render/fonts/IBMPlexSans-Variable.ttf");

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The strip under one panel: a dark band with the model name and its cost; the cheapest known clip is marked. Drawn with sharp and a bundled font (no ffmpeg text filter needed). */
export async function labelPng(p: Panel, isCheapest: boolean, outFile: string): Promise<void> {
  const [name, cost] = labelLines(p);
  const text = await sharp({
    text: { text: `<span foreground="white" size="22000"><b>${esc(name)}</b></span>\n<span foreground="${isCheapest ? "#7CFFB2" : "#D8D8D8"}" size="19000">${esc(cost)}${isCheapest ? "  (cheapest)" : ""}</span>`, font: "IBM Plex Sans", fontfile: FONT, width: PANEL.width - 24, rgba: true, wrap: "word-char" },
  }).png().toBuffer();
  await sharp({ create: { width: PANEL.width, height: LABEL_HEIGHT, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.72 } } })
    .composite([{ input: text, left: 12, top: 8 }])
    .png()
    .toFile(outFile);
}

/** Side-by-side grid of the clips (labels included) as one MP4. Reads the clips, writes only `out` (and temporary label images that are removed). Returns ffmpeg's problem text on failure. */
export async function renderGrid(panels: readonly Panel[], out: string, ffmpeg = "ffmpeg"): Promise<{ ok: true } | { ok: false; message: string }> {
  const problem = gridProblem(panels);
  if (problem) return { ok: false, message: problem };
  const dir = await mkdtemp(path.join(tmpdir(), "bakeoff-"));
  try {
    const best = new Set(cheapest(panels));
    const labels: string[] = [];
    for (const [i, p] of panels.entries()) {
      const f = path.join(dir, `label-${i}.png`);
      await labelPng(p, best.has(i) && panels.length > 1, f);
      labels.push(f);
    }
    await run(ffmpeg, gridArgs(panels, labels, out), { maxBuffer: 4 * 1024 * 1024, timeout: 600_000 });
    return { ok: true };
  } catch (e) {
    return { ok: false, message: String((e as { stderr?: unknown }).stderr ?? (e as Error).message).slice(0, 500) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
