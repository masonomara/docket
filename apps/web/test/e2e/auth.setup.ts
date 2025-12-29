/**
 * Auth Setup for E2E Tests
 *
 * This setup file authenticates a test user and saves the session state
 * so that subsequent tests can run as an authenticated user.
 *
 * To run authenticated tests, set these environment variables:
 *   - TEST_USER_EMAIL: Email of the test account
 *   - TEST_USER_PASSWORD: Password for the test account
 *   - TEST_USER_NAME: Display name (used if creating a new account)
 *
 * Or set E2E_AUTH_ENABLED=true to use the defaults.
 */

import { test as setup, expect } from "@playwright/test";

// Where to save the authenticated session
const AUTH_STATE_FILE = "test/e2e/.auth/user.json";

// Test user credentials (from env or defaults for local testing)
const TEST_USER = {
  email: process.env.TEST_USER_EMAIL || "test@e2e.docket.local",
  password: process.env.TEST_USER_PASSWORD || "TestPassword123!",
  name: process.env.TEST_USER_NAME || "E2E Test User",
};

setup("authenticate", async ({ page }) => {
  // Skip if auth testing isn't enabled
  const authEnabled =
    process.env.TEST_USER_EMAIL || process.env.E2E_AUTH_ENABLED;

  if (!authEnabled) {
    setup.skip(
      true,
      "Skipped: Set TEST_USER_EMAIL or E2E_AUTH_ENABLED to run authenticated tests"
    );
    return;
  }

  // First, check if we're already logged in
  await page.goto("/dashboard");
  await page.waitForTimeout(2000);

  const alreadyLoggedIn = page.url().includes("/dashboard");
  if (alreadyLoggedIn) {
    await page.context().storageState({ path: AUTH_STATE_FILE });
    return;
  }

  // Navigate to auth page and enter email
  await page.goto("/auth");
  await page.waitForTimeout(1000);

  await page.getByLabel(/email/i).fill(TEST_USER.email);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.waitForTimeout(1500);

  // Determine which auth flow we're in
  const isLoginPage = await page
    .getByRole("heading", { name: /welcome back/i })
    .isVisible()
    .catch(() => false);

  const isSignupPage = await page
    .getByRole("heading", { name: /create your account/i })
    .isVisible()
    .catch(() => false);

  const isOAuthOnlyPage = await page
    .getByText(/uses Google sign-in/i)
    .isVisible()
    .catch(() => false);

  // Handle OAuth-only accounts (can't test these with password)
  if (isOAuthOnlyPage) {
    throw new Error(
      `Account ${TEST_USER.email} uses Google sign-in. ` +
        `Create a password-based test account instead.`
    );
  }

  // Handle new account signup
  if (isSignupPage) {
    await page.getByLabel(/name/i).fill(TEST_USER.name);
    await page.getByLabel(/password/i).fill(TEST_USER.password);
    await page.getByRole("button", { name: /sign up/i }).click();
    await page.waitForTimeout(2000);

    // Check if we made it to dashboard
    if (page.url().includes("/dashboard")) {
      await page.context().storageState({ path: AUTH_STATE_FILE });
      return;
    }

    // Check if email verification is required
    const needsVerification = await page
      .getByRole("heading", { name: /check your email/i })
      .isVisible()
      .catch(() => false);

    if (needsVerification) {
      throw new Error(
        `Account created for ${TEST_USER.email} but requires email verification. ` +
          `Verify the account manually or use a pre-verified test account.`
      );
    }
  }

  // Handle existing account login
  if (isLoginPage) {
    await page.getByLabel(/password/i).fill(TEST_USER.password);
    await page.getByRole("button", { name: /log in/i }).click();
    await expect(page).toHaveURL("/dashboard", { timeout: 10000 });
  }

  // If we got here without handling a known state, something went wrong
  if (!isLoginPage && !isSignupPage) {
    await page.screenshot({ path: "test-results/auth-debug.png" });
    throw new Error(
      `Unexpected auth state for ${TEST_USER.email}. ` +
        `Screenshot saved to test-results/auth-debug.png`
    );
  }

  // Save the authenticated session
  await page.context().storageState({ path: AUTH_STATE_FILE });
});
