import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// What the CI `images` job and the no-python check rely on, and what keeps the service small. The image itself is built and checked there.
const df = readFileSync("infra/Dockerfile.render-runner", "utf8");
const code = df.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n"); // comments may say "python"
const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };

describe("infra/Dockerfile.render-runner", () => {
  it("bundles the service with esbuild from the repo's own pinned versions (no npm install of the app)", () => {
    expect(df).toMatch(/esbuild infra\/render-runner\/main\.ts --bundle --platform=node/);
    expect(df).toMatch(/\["esbuild","zod"\]/);
  });
  it("copies only what the bundle imports", () => {
    expect(df).toMatch(/COPY infra\/render-runner\/\*\.ts/);
    expect(df).toMatch(/COPY src\/server\/render /);
    expect(df).toMatch(/COPY src\/server\/core\/paid-call\.ts src\/server\/core\/spend\.ts/);
    expect(df).not.toMatch(/COPY \. /);
  });
  it("gets the Docker CLI as a static binary, and nothing that ships Python or a package manager", () => {
    expect(df).toContain("COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker");
    expect(df).toMatch(/rm -rf \/usr\/local\/lib\/node_modules[^\n]*\/usr\/local\/bin\/npm/);
    expect(code).not.toMatch(/\bpython3?\b|\bpip3?\b|apk add/i);
  });
  it("runs as a non-root user, in production mode, listening on 4100", () => {
    expect(df).toMatch(/^USER \d+:\d+/m);
    expect(df).toContain("ENV NODE_ENV=production");
    expect(df).toContain("EXPOSE 4100");
    expect(df).toMatch(/ENTRYPOINT \["node", "\/app\/runner\.js"\]/);
  });
  it("has a package script to build it", () => {
    expect(pkg.scripts["image:render-runner"]).toBe("docker build -f infra/Dockerfile.render-runner -t ytstudio-render-runner:dev .");
  });
});
