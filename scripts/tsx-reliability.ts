// Phase 0 Remotion check, TSX reliability: how often does a model-written Remotion composition compile and render
// ONE frame inside the render sandbox (network none, read-only root)? Uses our agent loop + jailed writeFile with a
// LOCAL model (Ollama, price 0). Refuses anything but a loopback base URL, so no paid API can be hit by accident.
//
//   npx tsx scripts/tsx-reliability.ts            (env: TSX_MODEL=qwen2.5:7b, TSX_BASE_URL=http://127.0.0.1:11434/v1,
//                                                 TSX_N=10, TSX_RETRIES=2, TSX_OUT=<json path>)
// Needs: Docker up and the image built (`npm run image:render`). Prints one JSON report on the last line.
import { execFile } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { runAgent, type AgentTool, type Message } from "@/server/core/agent-loop";
import type { PaidCallPorts } from "@/server/core/paid-call";
import { createAiSdkStep } from "@/server/llm/ai-sdk-step";
import { createJail } from "@/server/llm/jail";
import { removeJobContainers, startRenderJob } from "@/server/render/runner";

const run = promisify(execFile);
const FIXTURE = path.resolve("tests/fixtures/remotion-tsx");
const MODEL = process.env.TSX_MODEL ?? "qwen2.5:7b";
const BASE_URL = process.env.TSX_BASE_URL ?? "http://127.0.0.1:11434/v1";
const RETRIES = Number(process.env.TSX_RETRIES ?? "2");
const RENDER_TIMEOUT_MS = 240_000;

const PROMPTS = [
  "A dark blue background with the white title 'Hello World' centred, fading in over the first 20 frames.",
  "Three coloured circles (red, green, blue) in a row that grow from scale 0 to 1 one after another.",
  "A progress bar at the bottom that fills from 0% to 100% across the whole duration, with the percentage as text above it.",
  "A big counter in the middle that counts from 0 to 100 as the frames advance.",
  "A gradient background (purple to orange) with a square that spins 360 degrees over the duration.",
  "Three bullet points that slide in from the left one after another, white text on black.",
  "A pulsing yellow circle in the centre whose size oscillates with a sine wave, plus the caption 'Breathe'.",
  "A title 'Top 3 Facts' at the top, then three numbered cards (1, 2, 3) that appear one by one, each with a short fact.",
  "A rotating square outline with the text 'Loading' under it that bounces up and down.",
  "A split screen: left half red with the word 'BEFORE', right half green with the word 'AFTER', the right half wipes in.",
  "A typewriter effect revealing the sentence 'Remotion makes video with code' letter by letter, monospace font.",
  "A bar chart with four bars (heights 20, 50, 80, 35) that grow from the bottom, each labelled A to D.",
];

const MODE = process.env.TSX_MODE === "fence" ? "fence" : "tool";
const SYSTEM_FENCE = `You write one Remotion v4 video scene as a single TypeScript React file for a 1080x1920 portrait video, 30 fps, 60 frames long.
Rules:
- Reply with exactly one \`\`\`tsx code block containing the full file, and nothing else.
- The file must have a default export: export default function Scene() { ... }
- Import only from "react" and "remotion". Allowed remotion helpers: AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring, Sequence. No other packages, no images, no fonts, no network, no external files.
- Use inline styles only. Everything must be derived from useCurrentFrame() so it is deterministic.`;
const SYSTEM_TOOL = `You write one Remotion v4 video scene as a single TypeScript React file for a 1080x1920 portrait video, 30 fps, 60 frames long.
Rules:
- Call the writeFile tool exactly once with path "Scene.tsx" and the full file as content. Do not write anything else.
- The file must have a default export: export default function Scene() { ... }
- Import only from "react" and "remotion". Allowed remotion helpers: AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring, Sequence. No other packages, no images, no fonts, no network, no external files.
- Use inline styles only. Everything must be derived from useCurrentFrame() so it is deterministic.
- After writing the file, reply with the single word: done`;

const WRITE_DECL = {
  name: "writeFile",
  description: "Write a file in the scratch directory.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path", "content"],
  },
};

type Category = "ok" | "no_file" | "syntax" | "missing_module" | "no_default_export" | "runtime_error" | "timeout" | "other";

interface AttemptResult {
  attempt: number; // 0 = first try
  stage: "model" | "compile" | "render" | "ok";
  category: Category;
  modelMs: number;
  renderMs: number;
  codeVia: "writeFile" | "fence" | "none";
  error?: string;
}
interface PromptResult {
  prompt: string;
  attempts: AttemptResult[];
}

function classify(stage: string, error: string): Category {
  if (/Module not found|Can't resolve/i.test(error)) return "missing_module";
  if (/has no default export|export 'default'.*was not found|Attempted import error/i.test(error)) return "no_default_export";
  if (stage === "compile") return /Unexpected token|Syntax|Expected|Unterminated|Parsing|Transform failed|Build failed|esbuild|Failed to compile/i.test(error) ? "syntax" : "other";
  if (stage === "render") return /timed out|timeout/i.test(error) ? "timeout" : "runtime_error";
  return "other";
}

const ports: PaidCallPorts = {
  reserve: async () => ({ kind: "new", intentId: "local" }),
  settle: async () => {},
  failKnown: async () => {},
  markUnknown: async () => {},
  markStageNeedsDecision: async () => {},
  warn: (e, d) => console.warn(e, d),
};

async function renderOnce(storageRoot: string, tag: string, code: string): Promise<{ ok: boolean; stage: string; error: string; renderMs: number }> {
  const jobId = `tsx-${tag}`;
  const jobDir = path.join(storageRoot, "jobs", jobId);
  await mkdir(path.dirname(jobDir), { recursive: true });
  await cp(FIXTURE, jobDir, { recursive: true });
  await mkdir(path.join(jobDir, "scenes"), { recursive: true });
  await writeFile(path.join(jobDir, "scenes", "Scene.tsx"), code, "utf8");
  await run("chmod", ["-R", "a+rwX", jobDir]); // the container runs as uid 10001
  await chmod(jobDir, 0o777);
  const t0 = performance.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), RENDER_TIMEOUT_MS);
  try {
    const job = await startRenderJob({
      jobId,
      storageRoot,
      jobDir,
      signal: ac.signal,
      command: ["sh", "-c", 'node "$1/gen-registry.mjs" "$1" && node "$1/render-scene.mjs" "$1"', "sh", jobDir],
    });
    const { exitCode, logs } = await job.wait();
    const last = logs.trim().split("\n").reverse().find((l) => l.startsWith("{"));
    const renderMs = Math.round(performance.now() - t0);
    if (last) {
      const j = JSON.parse(last) as { ok: boolean; stage?: string; error?: string };
      return { ok: j.ok, stage: j.ok ? "ok" : (j.stage ?? "render"), error: j.error ?? "", renderMs };
    }
    return { ok: false, stage: "render", error: `exit ${exitCode}, no result line. ${logs.slice(-1500)}`, renderMs };
  } catch (e) {
    const timedOut = ac.signal.aborted;
    return { ok: false, stage: "render", error: timedOut ? "timeout: render exceeded limit" : String(e), renderMs: Math.round(performance.now() - t0) };
  } finally {
    clearTimeout(timer);
    await removeJobContainers(jobId).catch(() => undefined);
  }
}

async function writeScene(model: ReturnType<ReturnType<typeof createOpenAICompatible>>, scratch: string, messages: Message[]) {
  const jail = await createJail(scratch);
  await rm(path.join(jail.root, "Scene.tsx"), { force: true });
  const writeTool = jail.tools.find((t) => t.name === "writeFile") as AgentTool;
  const tools: AgentTool[] = MODE === "fence" ? [] : [writeTool];
  const out = await runAgent({
    claim: { stageRunId: "tsx-reliability" } as never,
    ports,
    price: { inputPerMTokMicro: 0, outputPerMTokMicro: 0 },
    budgetScopes: ["spike"],
    maxOutputTokens: 3000,
    maxSteps: 4,
    step: createAiSdkStep(model, MODE === "fence" ? [] : [WRITE_DECL], 3000),
    tools,
    messages,
  });
  let code: string | undefined;
  let via: AttemptResult["codeVia"] = "none";
  try {
    code = await readFile(path.join(jail.root, "Scene.tsx"), "utf8");
    via = "writeFile";
  } catch {
    // Local models sometimes answer with a code fence instead of calling the tool. Counted separately.
    const fence = out.text.match(/```(?:tsx|typescript|ts|jsx)?\n([\s\S]*?)```/);
    if (fence?.[1]) {
      code = fence[1];
      via = "fence";
      await writeTool.run({ path: "Scene.tsx", content: code }); // still lands in the jailed scratch dir
      code = await readFile(path.join(jail.root, "Scene.tsx"), "utf8");
    }
  }
  return { code, via, messages: out.messages, text: out.text, steps: out.steps };
}

async function main() {
  const host = new URL(BASE_URL).hostname;
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) throw new Error("TSX_BASE_URL must be loopback: this spike never calls a paid or remote API");
  const n = Math.min(Number(process.env.TSX_N ?? "10"), PROMPTS.length);
  const model = createOpenAICompatible({ name: "local", baseURL: BASE_URL })(MODEL);
  const storageRoot = await realpath(await mkdtemp(path.join(tmpdir(), "tsx-rel-")));
  await chmod(storageRoot, 0o755);
  const results: PromptResult[] = [];

  for (let i = 0; i < n; i++) {
    const prompt = PROMPTS[i] as string;
    const scratch = path.join(storageRoot, "scratch", `p${i}`);
    const attempts: AttemptResult[] = [];
    let messages: Message[] = [
      { role: "system", content: MODE === "fence" ? SYSTEM_FENCE : SYSTEM_TOOL },
      { role: "user", content: `Scene: ${prompt}` },
    ];
    for (let a = 0; a <= RETRIES; a++) {
      const t0 = performance.now();
      let w: Awaited<ReturnType<typeof writeScene>> | undefined;
      let modelError = "";
      try {
        w = await writeScene(model, scratch, messages);
      } catch (e) {
        modelError = String(e);
      }
      const modelMs = Math.round(performance.now() - t0);
      if (!w?.code) {
        attempts.push({ attempt: a, stage: "model", category: "no_file", modelMs, renderMs: 0, codeVia: "none", error: modelError || `model wrote no file and no code block; steps=${w?.steps}; text=${(w?.text ?? "").slice(0, 400)}` });
        console.log(`p${i} a${a} no_file ${modelMs}ms`);
        break; // nothing to feed back
      }
      const r = await renderOnce(storageRoot, `${i}-${a}-${process.pid}`, w.code);
      const category: Category = r.ok ? "ok" : classify(r.stage, r.error);
      attempts.push({
        attempt: a,
        stage: r.ok ? "ok" : (r.stage as "compile" | "render"),
        category,
        modelMs,
        renderMs: r.renderMs,
        codeVia: w.via,
        error: r.ok ? undefined : r.error.slice(0, 600),
      });
      console.log(`p${i} a${a} ${category} model=${modelMs}ms render=${r.renderMs}ms via=${w.via}`);
      if (r.ok) break;
      messages = [
        ...messages,
        { role: "assistant", content: `\`\`\`tsx\n${w.code}\n\`\`\`` },
        {
          role: "user",
          content: `Your file failed at the ${r.stage} step with this error:\n${r.error.slice(0, 1500)}\n\nFix it. ${MODE === "fence" ? "Reply with one tsx code block containing the complete corrected file." : 'Call writeFile once with path "Scene.tsx" and the complete corrected file.'}`,
        },
      ];
    }
    results.push({ prompt, attempts });
  }

  const firstTry = results.map((r) => r.attempts[0]);
  const count = (f: (a: AttemptResult) => boolean) => firstTry.filter((a): a is AttemptResult => !!a && f(a)).length;
  const okBy = (k: number) => results.filter((r) => r.attempts.slice(0, k + 1).some((a) => a.category === "ok")).length;
  const cats: Record<string, number> = {};
  for (const r of results) for (const a of r.attempts) if (a.category !== "ok") cats[a.category] = (cats[a.category] ?? 0) + 1;
  const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((s, x) => s + x, 0) / xs.length) : 0);
  const report = {
    model: MODEL,
    mode: MODE,
    n,
    firstTry: {
      codeProduced: count((a) => a.codeVia !== "none"),
      compiled: count((a) => a.stage === "render" || a.stage === "ok"),
      rendered: count((a) => a.stage === "ok"),
      viaFence: count((a) => a.codeVia === "fence"),
    },
    renderedAfterRetries: Array.from({ length: RETRIES + 1 }, (_, k) => ({ maxAttempts: k + 1, rendered: okBy(k) })),
    errorCategoriesAllAttempts: cats,
    avgModelMs: avg(results.flatMap((r) => r.attempts.map((a) => a.modelMs))),
    avgRenderMs: avg(results.flatMap((r) => r.attempts.filter((a) => a.renderMs > 0).map((a) => a.renderMs))),
    results,
  };
  if (process.env.TSX_OUT) await writeFile(process.env.TSX_OUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  await rm(storageRoot, { recursive: true, force: true }).catch(() => undefined);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
