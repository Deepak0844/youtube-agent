// `npm run check`: are the tools a video needs on this computer (ffmpeg, ffprobe, Docker, the render image)? Same checks as Settings > System.
// Prints one line each and exits 1 when something needs attention. Changes nothing.
import { toolsSummary } from "@/server/core/tool-check";
import { runToolChecks } from "@/server/render/tool-check";

async function main(): Promise<number> {
  const checks = await runToolChecks();
  for (const c of checks) console.log(`${c.ok ? "ok   " : "FAIL "} ${c.label}: ${c.detail}${c.fix ? ` ${c.fix}` : ""}`);
  const s = toolsSummary(checks);
  console.log(s.line);
  return s.ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  () => {
    console.error("The tool check could not run.");
    process.exit(1);
  },
);
