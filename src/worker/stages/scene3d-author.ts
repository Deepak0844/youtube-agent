import { lstat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { sha256Hex } from "@/server/core/content-hash";
import type { Message } from "@/server/core/agent-loop";
import { KnownFailure } from "@/server/core/paid-call";
import { SCENE_MAX_S, sceneProps, type AuthorBeat } from "@/server/core/scene3d-author-prompt";
import { authorScene3d } from "@/server/core/scene3d-author";
import { sceneModelIds } from "@/server/core/scene3d-code-check";
import type { Scene3dCodeBody } from "@/server/core/scene3d-code-body";
import { pickCandidates } from "@/server/core/scene3d-direct";
import { STORY_LIMITS, storyBeatSchema } from "@/server/core/script-contract";
import { beatTimings, type PromptBeat, type PromptWord } from "@/server/core/tsx-prompt";
import { approvedScript } from "@/server/db/stage-content";
import type { LlmClient, LlmStageContext } from "@/server/llm/client";
import { typeCheckScene3d } from "@/server/render/scene3d-typecheck";
import { ALLOWED_LICENSES } from "@/shared/assets3d/schema";
import { promotedPath, type AttemptHandler } from "./attempt";
import { contentBody, loadVideo, videoMoneyScopes, type StageDeps } from "./deps";
import { audioSeconds } from "./voice-audio";

const AUTHOR_STAGE_TOKENS = 16_000;

/** One reserved, paid model call per attempt, through the author_scene3d route (plain text back). A budget refusal or an unclear outcome goes up as is: the runner parks the stage for the owner. Never retried here. */
export function authorAsk(llm: LlmClient, ctx: LlmStageContext): (messages: Message[]) => Promise<string> {
  return async (messages) => (await llm.agent(ctx, { stage: "author_scene3d", tools: [], messages, maxSteps: 1, maxOutputTokens: AUTHOR_STAGE_TOKENS })).text;
}

/**
 * scene3d_author: the AI writes ONE scene.tsx for a scene3d_code video, AFTER the narration exists (so it sees the real beat times). The
 * reply is checked statically and type-checked here; nothing runs it. The accepted source is stored as `scenes` content (body kind
 * "scene3d_code") plus the file scene.tsx. Four attempts at most, then it fails with scene3d_author_invalid: there is no fallback.
 */
export function scene3dAuthorAttempt(deps: StageDeps): AttemptHandler {
  return async (ctx) => {
    if (!deps.makeLlm) throw new KnownFailure("No scene model is wired, so the 3D scene cannot be written.");
    if (!deps.catalog3d) throw new KnownFailure("The 3D model catalogue is not wired, so the 3D scene cannot be written.");
    const video = await loadVideo(deps.db, ctx);
    if (video.kind !== "scene3d_code") throw new KnownFailure("This video is not a 3D story with an AI-written scene.");
    const script = await approvedScript(deps.db, video.id);
    if (!script.ok) throw new KnownFailure(script.reason);
    const story = z.array(storyBeatSchema).min(STORY_LIMITS.minBeats).max(STORY_LIMITS.maxBeats).safeParse(script.script.story);
    if (!story.success) throw new KnownFailure("The approved script has no valid 3D story. Send the script back for a new draft.");
    const catalog = await deps.catalog3d().catch(() => {
      throw new KnownFailure("The 3D model catalogue could not be read (assets3d/manifest.json).");
    });

    const narration = await contentBody<{ file?: unknown }>(deps.db, video.id, "narration");
    if (typeof narration.file !== "string") throw new KnownFailure("The narration record has no audio file. Run the voice step again.");
    const audioFile = await promotedPath(deps.root, video.id, narration.file);
    if (!(await lstat(audioFile).catch(() => null))?.isFile()) throw new KnownFailure(`The file ${narration.file} from an earlier stage is missing. Run that stage again.`);
    const captions = await contentBody<{ words?: unknown }>(deps.db, video.id, "captions").catch(() => null);
    const words: PromptWord[] = (Array.isArray(captions?.words) ? captions.words : []).flatMap((w: unknown) => {
      const x = w as { word?: unknown; startS?: unknown; endS?: unknown };
      return typeof x?.word === "string" && typeof x.startS === "number" && typeof x.endS === "number" ? [{ word: x.word, startS: x.startS, endS: x.endS }] : [];
    });
    const lastEnd = words.length > 0 ? Math.max(...words.map((w) => w.endS)) + 0.3 : 0;
    const narrationS = await audioSeconds(deps.mix, ctx, audioFile).catch(() => lastEnd);
    if (!(narrationS > 0)) throw new KnownFailure("The length of the narration is not known. Run the voice step again.");
    if (narrationS > SCENE_MAX_S) throw new KnownFailure(`The narration is ${Math.round(narrationS)} s; a 3D story can run at most ${SCENE_MAX_S} s. Send the script back for a shorter draft.`);

    const promptBeats: PromptBeat[] = story.data.map((b) => ({ id: b.id, text: b.line, visual: b.visual }));
    const timed = beatTimings(promptBeats, words, narrationS);
    const beats: AuthorBeat[] = story.data.map((b, i) => ({ id: b.id, line: b.line, visual: b.visual, from: timed[i]!.realStartS ?? timed[i]!.estStartS, to: timed[i]!.realEndS ?? timed[i]!.estEndS }));
    const props = sceneProps(beats, narrationS);
    const candidates = pickCandidates(catalog, story.data.map((b) => ({ id: b.id, visual: b.visual, line: b.line })));
    ctx.log(`author: ${candidates.length} catalogue candidates for ${beats.length} story beats; film length ${props.durationS.toFixed(2)} s`);

    const llm = deps.makeLlm(await videoMoneyScopes(deps.db, video));
    const typeCheck = deps.sceneTypeCheck ?? typeCheckScene3d;
    const out = await authorScene3d(
      { ask: authorAsk(llm, ctx), typeCheck, log: ctx.log },
      { title: typeof script.script.title === "string" ? script.script.title : "", story: beats, candidates, narrationS, durationS: props.durationS },
    );

    const models = sceneModelIds(out.source, (id) => {
      const e = catalog.getById(id);
      return !!e && e.kind === "model" && (ALLOWED_LICENSES as readonly string[]).includes(e.license);
    });
    await writeFile(path.join(ctx.attemptDir, "scene.tsx"), out.source, { mode: 0o600 });
    const body: Scene3dCodeBody = { kind: "scene3d_code", source: out.source, source_sha256: sha256Hex(out.source), models, props, attempts: out.attempts };
    return {
      files: ["scene.tsx"],
      content: [{ kind: "scenes", body }],
      result: { kind: "scene3d_code", attempts: out.attempts, models: models.length, candidates: candidates.length, characters: out.source.length, durationS: props.durationS },
    };
  };
}
