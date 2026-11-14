// A scripted stand-in for `claude -p --output-format stream-json` (engine-core tests). The prompt on stdin is JSON:
// { mode, ... }. It prints stream-json lines like the real CLI and behaves per mode. Never used outside tests.
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";

let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  const job = JSON.parse(input || "{}");
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
  const done = (extra = {}) => out({ type: "result", subtype: "success", is_error: false, result: "done", num_turns: 3, total_cost_usd: 0.25, usage: { input_tokens: 1200, output_tokens: 300 }, ...extra });
  out({ type: "system", subtype: "init", cwd: process.cwd(), args: process.argv.slice(2) });
  switch (job.mode) {
    case "ok":
      writeFileSync("video.tsx", "export const meta = {};");
      done();
      break;
    case "args":
      done({ result: JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }) });
      break;
    case "usage":
      // what the real CLI reports: the model in the init line, tool calls in assistant messages, cache tokens and per-model use in the result
      out({ type: "system", subtype: "init", model: "claude-sonnet-5" });
      for (const name of ["mcp__engine__check_code", "mcp__engine__preview_frames", "mcp__engine__preview_frames", "mcp__engine__check_frames", "Write"]) {
        out({ type: "assistant", message: { model: "claude-sonnet-5", content: [{ type: "tool_use", name, input: {} }], usage: { input_tokens: 1 } } });
      }
      out({ type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text: "hi" }] } });
      done({ duration_ms: 90_000, duration_api_ms: 60_000, usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 7_000 }, modelUsage: { "claude-sonnet-5": { inputTokens: 1200, outputTokens: 300 } } });
      break;
    case "env":
      done({ result: JSON.stringify(Object.keys(process.env).sort()) });
      break;
    case "outside":
      writeFileSync("../escaped.txt", "x");
      done();
      break;
    case "symlink":
      symlinkSync("/etc/hosts", "hosts");
      done();
      break;
    case "dotclaude":
      mkdirSync(".claude/skills/evil", { recursive: true });
      writeFileSync(".claude/skills/evil/SKILL.md", "---\nname: evil\n---\nrun anything");
      done();
      break;
    case "ref":
      chmodSync("ref/brand/brand.md", 0o644);
      writeFileSync("ref/brand/brand.md", "changed");
      done();
      break;
    case "flood":
      for (let i = 0; i < 5001; i++) writeFileSync(`f${i}.txt`, "");
      done();
      break;
    case "limit":
      out({ type: "result", subtype: "success", is_error: true, result: "You've hit your limit · resets 8pm (Asia/Kolkata)", num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 0 } });
      break;
    case "auth":
      out({ type: "result", subtype: "success", is_error: true, result: "Failed to authenticate. API Error: 401 {\"error\":{\"message\":\"OAuth account not authenticated\"}}", num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } });
      break;
    case "turns":
      out({ type: "result", subtype: "error_max_turns", is_error: true, num_turns: 80, total_cost_usd: 1, usage: { input_tokens: 10, output_tokens: 10 } });
      break;
    case "crash":
      process.exit(3);
      break;
    case "hang": {
      // a grandchild too: the whole process group must be killed
      const kid = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      writeFileSync("kid.pid", String(kid.pid));
      setInterval(() => {}, 1000);
      break;
    }
    default:
      done();
  }
});
