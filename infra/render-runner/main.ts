import { loadRunnerConfig } from "./config";
import { dockerDeps } from "./docker";
import { createRunnerServer } from "./server";

const loaded = loadRunnerConfig(process.env);
if (!loaded.ok) {
  process.stderr.write(`render-runner: ${loaded.error}\n`);
  process.exit(1);
}
const cfg = loaded.config;

const server = createRunnerServer(dockerDeps(cfg));

server.listen(cfg.port, "0.0.0.0", () => process.stdout.write(`render-runner listening on :${cfg.port}\n`));
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => server.close(() => process.exit(0)));
