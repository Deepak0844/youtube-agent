// Side-by-side comparison of AI clips: npm run bakeoff:grid -- --out grid.mp4 clipA.mp4="Seedance 2.0 fast"=0.42 clipB.mp4="Kling 4.0"=0.55
// Each clip is FILE=LABEL=COST_USD (cost is what the app recorded for that clip; leave it out, or write ?, when unknown). Reads the clips, writes only the grid.
// Nothing here calls a provider or spends money. Make the same short with different models (each shows its price at the cost gate), then compare.
import path from "node:path";
import { gridProblem, type Panel } from "@/server/core/bakeoff";
import { renderGrid } from "@/server/render/bakeoff";

const args = process.argv.slice(2).filter((a) => a !== "--");
const outAt = args.indexOf("--out");
const out = outAt >= 0 ? args[outAt + 1] : undefined;
const specs = args.filter((_, i) => i !== outAt && i !== outAt + 1);
if (!out || specs.length === 0) {
  console.error('usage: npm run bakeoff:grid -- --out grid.mp4 file.mp4="Label"=0.42 file2.mp4="Label 2"');
  process.exit(1);
}
const panels: Panel[] = specs.map((s) => {
  const [file = "", label = "", cost] = s.split("=");
  const usd = cost === undefined || cost === "" || cost === "?" ? null : Number(cost);
  return { file: path.resolve(file), label, costMicroUsd: usd === null ? null : Number.isFinite(usd) && usd >= 0 ? Math.round(usd * 1_000_000) : Number.NaN };
});
const problem = gridProblem(panels);
if (problem) {
  console.error(problem);
  process.exit(1);
}
void renderGrid(panels, path.resolve(out)).then((r) => {
  if (!r.ok) {
    console.error(r.message);
    process.exit(1);
  }
  console.log(`grid written to ${path.resolve(out)}`);
});
