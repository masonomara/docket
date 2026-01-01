import path from "node:path";
import {
  defineWorkersConfig,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
  // Load database migrations from the migrations folder
  const migrationsPath = path.join(__dirname, "migrations");
  const migrations = await readD1Migrations(migrationsPath);

  // Check if we have Cloudflare credentials for integration tests
  const hasCloudflareAccount = !!process.env.CLOUDFLARE_ACCOUNT_ID;

  return {
    test: {
      // Run migration setup before each test file
      setupFiles: ["./test/apply-migrations.ts"],

      // Exclude e2e tests - they have their own config
      exclude: ["test/e2e/**", "node_modules/**"],

      poolOptions: {
        workers: {
          // Use single worker to avoid test isolation issues with DO state
          singleWorker: true,

          // Enable remote bindings for Vectorize and AI
          remoteBindings: hasCloudflareAccount,

          // Point to our wrangler config for bindings
          wrangler: {
            configPath: "./wrangler.jsonc",
          },

          // Miniflare-specific bindings for testing
          miniflare: {
            bindings: {
              // Pass migrations to the test setup file
              TEST_MIGRATIONS: migrations,

              // Flag to enable/disable integration tests that need real Cloudflare APIs
              INTEGRATION_TESTS_ENABLED: hasCloudflareAccount,
            },
          },
        },
      },
    },
  };
});
