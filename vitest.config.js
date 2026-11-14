import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(root, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        // The test Worker exports a Clock built around the tests' config.
        main: "./test/worker.js",
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            ADMIN_TOKEN: "test-admin-token-0123456789",
            LINK_SECRET: "test-link-secret-0123456789abcdef0123456789",
            SESSION_SECRET: "test-session-secret-0123456789abcdef012345",
            IP_SALT: "test-ip-salt-0123456789",
            RESEND_API_KEY: "re_test_key",
            TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
            TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
            GITHUB_TOKEN: "github_pat_test",
            KEYS_TOKEN: "keys-test-token-0123456789",
            MAIL_FROM: "Beta <beta@example.com>",
            OWNER_EMAIL: "owner@example.com",
            PUBLIC_URL: "https://beta.test",
            // Tests drive Clock runs directly with chosen times.
            PAUSE_ALARMS: "1",
          },
          // R2 runs for real in Miniflare (local R2).
          r2Buckets: ["FILES"],
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.js"],
      include: ["test/**/*.test.js"],
    },
  };
});
