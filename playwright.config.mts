import { defineConfig, devices } from "@playwright/test";
import getPort from "get-port";
import { STORAGE_STATE } from "./tests/e2e/fixtures/owner";

// Workers re-evaluate this file with the parent's env, so the port is chosen once.
process.env.E2E_PORT ??= String(await getPort());
const baseURL = `http://127.0.0.1:${process.env.E2E_PORT}`;

export default defineConfig({
  testDir: "tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  outputDir: "test-results",
  workers: 1, // the e2e server runs with AUTH_MAX_IN_FLIGHT=1 (see global-setup.ts), so specs must not log in in parallel
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    { name: "api", testMatch: "**/*.api.spec.ts" },
    {
      name: "ui-desktop",
      testMatch: "**/*.ui.spec.ts",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 }, storageState: STORAGE_STATE },
    },
    {
      name: "ui-phone",
      testMatch: "**/*.ui.spec.ts",
      use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, storageState: STORAGE_STATE },
    },
  ],
});
