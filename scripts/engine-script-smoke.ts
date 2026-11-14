// Manual smoke run of the engine's script step (D3, ADR 0015 addendum): real research runs on the owner's subscription with the
// app's own web tools (SEARXNG_URL), judged by the same contract and evidence checks as the paid draft. Throwaway video rows are
// deleted at the end. Writes .data/compare/d3-scripts/<topic>.json for the owner to compare with the paid draft.
//   npm run engine:script-smoke -- "Why we need Docker" ["Another topic" ...]
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { judgeDraft } from "@/server/authoring/draft/evidence-check";
import { wordCount } from "@/server/core/lang";
import { getEngineConfig } from "@/server/db/engine-config";
import { getPool } from "@/server/db/pool";
import { createVideoRow } from "@/server/db/videos";
import { researchTools } from "@/server/engine/mcp/research-tools";
import { runEngine } from "@/server/engine/run";
import { scriptRequest } from "@/server/engine/script-prompt";
import { defaultEngineRoot } from "@/server/engine/workspace";
import { createWebTools } from "@/server/llm/web-tools";
import { storageRoot } from "@/server/storage/paths";

async function main(): Promise<void> {
  const topics = process.argv.slice(2);
  if (topics.length === 0) throw new Error('give at least one topic: npm run engine:script-smoke -- "Why we need Docker"');
  const searxUrl = process.env.SEARXNG_URL;
  if (!searxUrl) throw new Error("SEARXNG_URL is not set");
  const db = getPool();
  const config = await getEngineConfig(db);
  const out = path.resolve(".data/compare/d3-scripts");
  await mkdir(out, { recursive: true });
  try {
    for (const topic of topics) {
      const video = await createVideoRow(db, { format: "short", kind: "tsx", language: "en", topic });
      const fetched = new Map<string, string>();
      const web = createWebTools({ searxUrl });
      const judge = (raw: unknown, pages: ReadonlyMap<string, string>) => {
        const v = judgeDraft(raw, "en", "short", pages, "tsx");
        return v.ok ? ({ ok: true } as const) : ({ ok: false, problems: v.problems } as const);
      };
      const started = Date.now();
      try {
        const r = await runEngine(
          { db, root: defaultEngineRoot(), config: { ...config.engine, enabled: true }, tools: (ws) => researchTools({ workDir: ws.workDir, web, fetched, judge }) },
          { videoId: video.id, stageRunId: "0190f3a2-7c1e-7a55-9d3b-2f6c8a1b4e91", kind: "research", prompt: scriptRequest({ topic, lang: "en", kind: "tsx" }).prompt, long: false, signal: new AbortController().signal, model: config.engine.model },
        );
        const slug = topic.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
        if (!r.ok) {
          console.log(`${topic}: ${r.limit ? `usage limit until ${r.resumeAt.toISOString()}` : r.message}`);
          continue;
        }
        const raw = JSON.parse(await readFile(path.join(r.workDir, "draft", "script.json"), "utf8")) as { narration?: string };
        const verdict = judgeDraft(raw, "en", "short", fetched, "tsx");
        const sug = await readFile(path.join(r.workDir, "draft", "suggestion.json"), "utf8").catch(() => null);
        const seconds = Math.round((Date.now() - started) / 1000);
        await writeFile(path.join(out, `${slug}.json`), JSON.stringify({ topic, seconds, turns: r.turns, usage: r.usage, words: wordCount(raw.narration ?? ""), pages: [...fetched.keys()], verdict: verdict.ok ? "pass" : verdict.problems, suggestion: sug ? JSON.parse(sug) : null, script: raw }, null, 2));
        console.log(`${topic}: ${verdict.ok ? "PASS" : "FAIL " + verdict.problems.slice(0, 2).join("; ")} | ${wordCount(raw.narration ?? "")} words | ${fetched.size} pages | ${r.turns} turns | ${seconds} s | $${r.usage.costUsdEquiv.toFixed(2)} equiv`);
      } finally {
        await db.query("delete from videos where id = $1", [video.id]).catch(() => undefined);
        await rm(path.join(storageRoot(), "videos", video.id), { recursive: true, force: true });
        await rm(path.join(defaultEngineRoot(), "videos", video.id), { recursive: true, force: true });
      }
    }
  } finally {
    await db.end();
  }
}

void main();
