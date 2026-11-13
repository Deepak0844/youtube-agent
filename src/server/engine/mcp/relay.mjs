// The engine tools relay (ADR 0015). Claude Code starts this as its MCP server "engine". It holds NO secrets and does no
// work: each JSON-RPC line from stdin is posted, in order, to the worker's private socket with the run's one-time token, and the
// answer line (if any) is written to stdout. The worker does the real work (renders in the locked container, asset lookups).
// Plain JavaScript so Claude Code can start it with node and nothing else.
import { request } from "node:http";
import { createInterface } from "node:readline";

const sock = process.env.ENGINE_SOCK;
const token = process.env.ENGINE_TOKEN;
if (!sock || !token) process.exit(2);

function post(line) {
  return new Promise((resolve) => {
    const req = request({ socketPath: sock, path: "/mcp", method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": Buffer.byteLength(line) }, timeout: 20 * 60_000 }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(res.statusCode === 200 ? Buffer.concat(chunks).toString("utf8") : null));
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => req.destroy());
    req.end(line);
  });
}

let chain = Promise.resolve();
createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  chain = chain.then(async () => {
    const out = await post(line);
    if (out) process.stdout.write(out.replace(/\n/g, " ") + "\n");
  });
});
