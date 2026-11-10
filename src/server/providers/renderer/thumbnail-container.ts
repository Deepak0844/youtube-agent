import { chmod, mkdir, open, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { KnownFailure } from "@/server/core/paid-call";
import type { StageContext } from "@/server/core/stage-handler";
import { daemonLimits } from "@/server/render/runner";
import { safeJoin } from "@/server/storage/paths";
import { ASSET_EXT, copyRegular, mountable, NAME_PREFIX, realDir, renderArgs, resolveRenderImage, runRenderContainer, type ContainerRendererDeps } from "./remotion-container";

// The long-video thumbnail card (1280x720 png), drawn in the same sandbox as every render: no network, read-only root, the kit mounted read-only,
// the title and an optional picture staged in a private input folder. The picture is a plain image file from the storage root (never a path the
// caller made up): the caller passes the storageRef of an asset it already looked up.

export const THUMBNAIL_PNG_MAX_BYTES = 6 * 1024 * 1024;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export interface ThumbnailInput {
  title: string;
  /** Picks the look (the video id, so the card matches the video). */
  seed: string;
  /** storageRef (relative to the storage root) of one image to show on the card, or absent for the title only. */
  pictureRef?: string;
  /** A plain file name made by the caller, written in the attempt folder. */
  outFile: string;
}

/** Reads the first bytes and checks the file really is a 1280x720 png (the size is in the IHDR chunk). Anything else is a plain refusal. */
export function pngProblem(head: Buffer): string | null {
  if (head.length < 24 || !PNG_MAGIC.every((b, i) => head[i] === b)) return "The thumbnail is not a png picture.";
  const w = head.readUInt32BE(16);
  const h = head.readUInt32BE(20);
  return w === 1280 && h === 720 ? null : `The thumbnail is ${w}x${h}, expected 1280x720.`;
}

export type ThumbnailRenderer = { draw(ctx: StageContext, a: ThumbnailInput): Promise<{ outPath: string; image: string }> };

export function createThumbnailRenderer(deps: Pick<ContainerRendererDeps, "root" | "kitDir" | "runChild" | "hostLimits" | "image" | "workerId" | "sweepDelayMs">) {
  const renderer: ThumbnailRenderer = {
    async draw(ctx: StageContext, a: ThumbnailInput): Promise<{ outPath: string; image: string }> {
      if (a.outFile === "" || a.outFile !== path.basename(a.outFile) || a.outFile.startsWith(".") || !a.outFile.endsWith(".png")) throw new Error("outFile must be a plain .png file name");
      if (a.title.trim() === "" || a.title.length > 300) throw new KnownFailure("The thumbnail needs a title of up to 300 characters.");
      const inDir = mountable(path.join(ctx.attemptDir, "thumb-in"));
      const outDir = mountable(path.join(ctx.attemptDir, "thumb-out"));
      const kitDir = mountable(deps.kitDir);
      await realDir(kitDir, "kit");
      const name = `${NAME_PREFIX}${ctx.claim.stageRunId.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 36)}-${randomBytes(4).toString("hex")}`;
      const cleanup = () => Promise.all([rm(inDir, { recursive: true, force: true }), rm(outDir, { recursive: true, force: true })]).catch(() => undefined);
      await cleanup();
      try {
        await mkdir(inDir, { recursive: true, mode: 0o755 });
        await mkdir(outDir, { mode: 0o700 });
        await chmod(inDir, 0o755);
        await chmod(outDir, 0o777); // the container runs as uid 10001; this folder holds nothing else
        let src: string | undefined;
        if (a.pictureRef !== undefined) {
          const ext = path.extname(a.pictureRef).toLowerCase();
          if (!ASSET_EXT.has(ext) || ext === ".mp4") throw new KnownFailure("The thumbnail picture has a file type the renderer does not take.");
          let file: string;
          try {
            file = await safeJoin(deps.root, a.pictureRef);
          } catch {
            throw new KnownFailure("The thumbnail picture could not be read.");
          }
          src = `picture${ext}`;
          await copyRegular(file, path.join(inDir, src), 20 * 1024 * 1024);
        }
        await writeFile(path.join(inDir, "props.json"), JSON.stringify({ title: a.title.trim(), seed: a.seed, ...(src ? { src } : {}) }), { mode: 0o644, flag: "wx" });
        await realDir(inDir, "input");
        await realDir(outDir, "output");

        const lim = ctx.config.render;
        const host = await (deps.hostLimits ?? daemonLimits)();
        const image = deps.image ? await deps.image() : await resolveRenderImage();
        const args = renderArgs({ name, limits: lim, host, imageRef: image.ref, workerId: deps.workerId, inDir, outDir, kitDir, entry: ["/in", "/out/out.png", "--thumbnail"] });
        const { r, tail } = await runRenderContainer(deps, ctx, { name, args, timeoutMs: Math.min(lim.timeoutS, 300) * 1000, maxOutputBytes: 256 * 1024 });
        if (r.aborted) throw ctx.signal.reason ?? new Error("render aborted");
        if (r.timedOut) throw new KnownFailure("The thumbnail took too long and was stopped.");
        if (r.truncated) throw new KnownFailure("The thumbnail render printed too much output and was stopped.");
        if (r.code !== 0) throw new KnownFailure(`The thumbnail failed (exit ${r.code ?? r.signal}). Last lines: ${tail.slice(-3).join(" | ")}`.slice(0, 600));

        const outPath = path.join(ctx.attemptDir, a.outFile);
        await rm(outPath, { force: true });
        await copyRegular(path.join(outDir, "out.png"), outPath, THUMBNAIL_PNG_MAX_BYTES).catch((e: unknown) => {
          throw new KnownFailure(e instanceof Error && /bigger than/.test(e.message) ? "The thumbnail is too big." : "The render finished but made no thumbnail.");
        });
        const fh = await open(outPath, "r");
        const head = Buffer.alloc(24);
        try {
          await fh.read(head, 0, 24, 0);
        } finally {
          await fh.close();
        }
        const bad = pngProblem(head);
        if (bad) {
          await rm(outPath, { force: true });
          throw new KnownFailure(bad);
        }
        return { outPath, image: image.ref };
      } finally {
        await cleanup();
      }
    },
  };
  return renderer;
}
