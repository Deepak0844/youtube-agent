// Runs INSIDE a child process started by the cut-out step: the only place the background-removal model and its native libraries run.
// A crash, hang or memory blow-up kills this child, never the worker or the web process.
// Usage: node cutout-child.mjs <inputPicture> <outputPng>
// Prints exactly one JSON line: { ok: true } or { ok: false, message }.
import { readFile, writeFile } from "node:fs/promises";
import { removeBackground } from "@imgly/background-removal-node";

const [input, output] = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
try {
  const bytes = await readFile(input);
  const blob = await removeBackground(new Blob([bytes], { type: "image/png" }), { model: "medium", output: { format: "image/png" } });
  await writeFile(output, Buffer.from(await blob.arrayBuffer()));
  out({ ok: true });
} catch (e) {
  out({ ok: false, message: e instanceof Error ? e.message.slice(0, 200) : "the background remover failed" });
  process.exitCode = 1;
}
