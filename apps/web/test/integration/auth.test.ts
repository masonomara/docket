/**
 * Authentication Integration Tests
 *
 * These tests verify the authentication flow against a running API server.
 * They require the API to be running locally and INTEGRATION=true to be set.
 *
 * To run: INTEGRATION=true npm test -- auth.test.ts
 */

import { describe, it, expect, afterAll } from "vitest";
import { execSync } from "child_process";
import { resolve } from "path";

// Configuration
const API_URL = process.env.API_URL || "http://localhost:8787";
const WEB_ORIGIN = process.env.WEB_ORIGIN || "http://localhost:5173";
const API_DIR = resolve(__dirname, "../../../api");

// Test user data (unique per test run)
const TEST_EMAIL = `test-${Date.now()}@example.com`;
const TEST_PASSWORD = "SecureP@ssw0rd123";
const TEST_NAME = "Test User";

// Session state (shared between tests)
let sessionCookie: string | null = null;

/* ==========================================================================
   Helper Functions
   ========================================================================== */

/**
 * Execute a SQL command against the local D1 database.
 * Used for test setup/teardown (e.g., verifying email).
 */
function executeD1(sql: string): void {
  try {
    execSync(`npx wrangler d1 execute docket-db --local --command "${sql}"`, {
      cwd: API_DIR,
      stdio: "pipe",
    });
  } catch {
    // Ignore errors - the command might fail if DB doesn't exist yet
  }
}

/**
 * Mark an email as verified in the database.
 * Needed because we can't click email verification links in tests.
 */
function verifyEmailInDatabase(email: string): void {
  executeD1(`UPDATE user SET email_verified = 1 WHERE email = '${email}'`);
}

/**
 * Extract cookies from a response's Set-Cookie headers.
 * Returns a string suitable for the Cookie header.
 */
function extractCookies(response: Response): string {
  const setCookieHeaders = response.headers.getSetCookie?.() || [];
  return setCookieHeaders.map((cookie) => cookie.split(";")[0]).join("; ");
}

/**
 * Make an authenticated fetch request to the API.
 * Automatically includes CORS headers and session cookie.
 */
async function authFetch(
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Origin: WEB_ORIGIN,
    ...((options.headers as Record<string, string>) || {}),
  };

  if (sessionCookie) {
    headers["Cookie"] = sessionCookie;
  }

  return fetch(`${API_URL}${path}`, {
    ...options,
    headers,
    credentials: "include",
  });
}

/* ==========================================================================
   Tests
   ========================================================================== */

describe("Authentication Flow", () => {
  // Clean up session state after all tests
  afterAll(() => {
    sessionCookie = null;
  });

  it("creates a new account", async () => {
    // Skip if integration tests aren't enabled
    if (!process.env.INTEGRATION) {
      return;
    }

    const response = await authFetch("/api/auth/sign-up/email", {
      method: "POST",
      body: JSON.stringify({
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
        name: TEST_NAME,
      }),
    });

    expect(response.ok).toBe(true);

    const data = (await response.json()) as { user?: { email: string } };
    expect(data.user?.email).toBe(TEST_EMAIL);

    // Verify email in DB so we can sign in
    verifyEmailInDatabase(TEST_EMAIL);
  });

  it("retrieves session with cookie", async () => {
    if (!process.env.INTEGRATION) {
      return;
    }

    // Sign in to get a session cookie
    const signInResponse = await authFetch("/api/auth/sign-in/email", {
      method: "POST",
      body: JSON.stringify({
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
      }),
    });

    expect(signInResponse.ok).toBe(true);

    // Extract and save the session cookie
    const cookies = extractCookies(signInResponse);
    if (cookies) {
      sessionCookie = cookies;
    }
    expect(sessionCookie).toBeTruthy();

    // Verify we can fetch the session
    const sessionResponse = await authFetch("/api/auth/get-session");
    expect(sessionResponse.ok).toBe(true);

    const session = (await sessionResponse.json()) as {
      user?: { email: string };
    };
    expect(session.user?.email).toBe(TEST_EMAIL);
  });

  it("fails to access protected route without session", async () => {
    if (!process.env.INTEGRATION) {
      return;
    }

    // Temporarily clear the session cookie
    const savedCookie = sessionCookie;
    sessionCookie = null;

    const response = await authFetch("/api/user/org");
    expect(response.status).toBe(401);

    // Restore the cookie for subsequent tests
    sessionCookie = savedCookie;
  });

  it("signs out successfully", async () => {
    if (!process.env.INTEGRATION) {
      return;
    }

    // Make sure we have a session first
    if (!sessionCookie) {
      const signInResponse = await authFetch("/api/auth/sign-in/email", {
        method: "POST",
        body: JSON.stringify({
          email: TEST_EMAIL,
          password: TEST_PASSWORD,
        }),
      });
      sessionCookie = extractCookies(signInResponse) || sessionCookie;
    }

    // Sign out
    const signOutResponse = await authFetch("/api/auth/sign-out", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(signOutResponse.ok).toBe(true);

    // Update cookie (should be cleared)
    sessionCookie = extractCookies(signOutResponse) || sessionCookie;

    // Verify session is gone
    const sessionResponse = await authFetch("/api/auth/get-session");
    const session = (await sessionResponse.json()) as { user?: unknown } | null;

    const isLoggedOut = session === null || session?.user === null;
    expect(isLoggedOut).toBe(true);
  });
});
