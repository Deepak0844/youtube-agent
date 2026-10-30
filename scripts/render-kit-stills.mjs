// Smoke: render frame 0 / mid / last of each kit piece inside the render image. Not run in CI.
// Usage: docker build -f infra/Dockerfile.render -t ytstudio-render:dev . && node scripts/render-kit-stills.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, ".data", "kit-stills");
mkdirSync(out, { recursive: true });
const frames = [0, 60, 119];
const ids = ["kit-terminal", "kit-chat", "kit-story", "kit-stock", "kit-pause", "kit-chat-window", "kit-browser", "kit-drawn", "kit-network", "kit-math", "kit-prob", "kit-sheet", "kit-chart-bar", "kit-chart-line", "kit-chart-pie", "kit-algo", "kit-collage-grid2", "kit-collage-grid3", "kit-collage-hero", "kit-collage-stagger", "kit-chess", "kit-piano", "kit-orbit", "kit-map"];
const cmd = ids
  .flatMap((id) => frames.map((f) => `npx remotion still kit/index.ts ${id} /out/${id}-${f}.png --frame=${f} --browser-executable=$REMOTION_BROWSER_EXECUTABLE --chrome-mode=headless-shell`))
  .join(" && ");
execFileSync(
  "docker",
  ["run", "--rm", "-v", `${path.join(root, "remotion", "kit")}:/opt/render/kit:ro`, "-v", `${out}:/out`, "-w", "/opt/render", "--user", "root", "--entrypoint", "sh", "ytstudio-render:dev", "-c", cmd],
  { stdio: "inherit" },
);
console.log("stills in", out);
