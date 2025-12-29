import { defineConfig, devices, type Project } from "@playwright/test";

const isCI = !!process.env.CI;
const baseURL = process.env.BASE_URL || "http://localhost:5173";
const authFile = "test/e2e/.auth/user.json";

// Build the list of test projects
const projects: Project[] = [
  // Auth setup project (runs first to establish session)
  {
    name: "setup",
    testMatch: /auth\.setup\.ts/,
  },

  // Public pages that don't require authentication
  {
    name: "unauthenticated",
    testMatch: /auth-and-org\.spec\.ts/,
    use: { ...devices["Desktop Chrome"] },
  },
];

// Only include authenticated tests when enabled via environment variable
if (process.env.E2E_AUTH_ENABLED) {
  projects.push({
    name: "authenticated",
    testMatch: /authenticated\.spec\.ts/,
    dependencies: ["setup"],
    use: { ...devices["Desktop Chrome"], storageState: authFile },
  });
}

export default defineConfig({
  testDir: "./test/e2e",
  workers: 1,

  // CI-specific settings
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  reporter: isCI ? "github" : "html",

  // Browser settings
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },

  projects,

  // Dev server
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: true,
    timeout: 60000,
  },
});
