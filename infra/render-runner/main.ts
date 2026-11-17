import { loadRunnerConfig } from "./config";
import { dockerDeps } from "./docker";
import { createRunnerServer } from "./server";

const loaded = loadRunnerConfig(process.env);
if (!loaded.ok) {
  process.stderr.write(`render-runner: ${loaded.error}\n`);
  process.exit(1);
}
const cfg = loaded.config;

const deps = dockerDeps(cfg);
const server = createRunnerServer(deps);

server.listen(cfg.port, "0.0.0.0", () => process.stdout.write(`render-runner listening on :${cfg.port}\n`));
// A wrong HOST_STORAGE_ROOT keeps the service "not ready" (so the studio waits); say why in the log.
void deps.hostRootProblem?.().then((p) => { if (p) process.stderr.write(`render-runner: ${p}\n`); });
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => server.close(() => process.exit(0)));
