import { defineConfig, devices } from "@playwright/test";
import { LOCAL_AUTH_STATE_PATH } from "./tests/browser/local-auth.setup";

const localAuthFixtureEnabled =
  process.env.SHADOWBOX_LOCAL_AUTH_FIXTURE === "1";

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  reporter: "line",
  globalSetup: localAuthFixtureEnabled
    ? "./tests/browser/local-auth.setup.ts"
    : undefined,
  use: {
    baseURL: "http://127.0.0.1:5174/agents",
    trace: "retain-on-failure",
    ...(localAuthFixtureEnabled
      ? { storageState: LOCAL_AUTH_STATE_PATH }
      : {}),
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command:
      'VITE_BRAIN_BASE_URL="${VITE_BRAIN_BASE_URL:-http://127.0.0.1:8788}" pnpm exec vite --host 127.0.0.1 --port 5174 --strictPort',
    url: "http://127.0.0.1:5174/agents/",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
