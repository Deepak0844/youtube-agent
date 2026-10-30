// Remotion Studio for remotion/kit inside the render image. Loopback only, kit mounted read-only, no env or secrets passed.
// Needs the image: npm run image:render. Open http://127.0.0.1:3100
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";

const kit = path.join(path.resolve(import.meta.dirname, ".."), "remotion", "kit");
try {
  execFileSync("docker", ["info"], { stdio: "ignore" });
} catch {
  console.error("Docker is not running. Start OrbStack and retry.");
  process.exit(1);
}
const r = spawnSync(
  "docker",
  ["run", "--rm", "-p", "127.0.0.1:3100:3000", "-v", `${kit}:/opt/render/kit:ro`, "-w", "/opt/render", "--entrypoint", "npx", "ytstudio-render:dev",
   "remotion", "studio", "kit/index.ts", "--port=3000", "--ipv4", "--no-open", "--browser-executable=/opt/render/chrome-headless-shell"],
  { stdio: "inherit" },
);
process.exit(r.status ?? 1);
