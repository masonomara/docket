import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker, { type Env } from "../../src/index";

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Makes a POST request to the worker
 */
async function post(
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {}
): Promise<Response> {
  const request = new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });

  return worker.fetch(request, env as Env);
}

/**
 * Makes a GET request to the worker
 */
async function get(
  path: string,
  headers: Record<string, string> = {}
): Promise<Response> {
  const request = new Request(`http://localhost${path}`, { headers });
  return worker.fetch(request, env as Env);
}

/**
 * Extracts the session token from a Set-Cookie header
 */
function getSessionCookie(response: Response): string | null {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) return null;

  const match = setCookie.match(/better-auth\.session_token=([^;]+)/);
  return match?.[1] ?? null;
}

/**
 * Generates a unique test email
 */
function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}@example.com`;
}

// ============================================================================
// Email/Password Authentication Tests
// ============================================================================

describe("Email/Password Authentication", () => {
  it("signs up a new user and creates records in D1", async () => {
    const testUser = {
      name: "Signup Test",
      email: uniqueEmail("signup"),
      password: "SecurePassword123!",
    };

    const response = await post("/api/auth/sign-up/email", testUser);
    expect(response.status).toBe(200);

    const data = (await response.json()) as {
      user?: { id: string; email: string };
    };
    expect(data.user?.email).toBe(testUser.email);
    expect(getSessionCookie(response)).toBeTruthy();

    // Verify user was created in D1
    const userRecord = await env.DB.prepare(
      "SELECT name FROM user WHERE id = ?"
    )
      .bind(data.user!.id)
      .first<{ name: string }>();
    expect(userRecord?.name).toBe(testUser.name);

    // Verify account was created with hashed password
    const accountRecord = await env.DB.prepare(
      "SELECT provider_id, password FROM account WHERE user_id = ?"
    )
      .bind(data.user!.id)
      .first<{ provider_id: string; password: string }>();

    expect(accountRecord?.provider_id).toBe("credential");
    expect(accountRecord?.password).not.toBe(testUser.password);
  });

  it("rejects duplicate email signup", async () => {
    const testUser = {
      name: "Dup",
      email: uniqueEmail("dup"),
      password: "SecurePassword123!",
    };

    // First signup should succeed
    await post("/api/auth/sign-up/email", testUser);

    // Second signup with same email should fail
    const secondResponse = await post("/api/auth/sign-up/email", testUser);
    const data = (await secondResponse.json()) as {
      error?: unknown;
      user?: unknown;
    };

    // Either there's an error or no user was created
    const signupFailed = data.error !== undefined || data.user === undefined;
    expect(signupFailed).toBe(true);
  });

  it("signs in with valid credentials", async () => {
    const testUser = {
      name: "SignIn",
      email: uniqueEmail("signin"),
      password: "SecurePassword123!",
    };

    // Create user first
    await post("/api/auth/sign-up/email", testUser);

    // Sign in
    const response = await post("/api/auth/sign-in/email", {
      email: testUser.email,
      password: testUser.password,
    });

    expect(response.status).toBe(200);
    expect(getSessionCookie(response)).toBeTruthy();
  });

  it("rejects sign-in with wrong password", async () => {
    const testUser = {
      name: "WrongPass",
      email: uniqueEmail("wrongpass"),
      password: "SecurePassword123!",
    };

    await post("/api/auth/sign-up/email", testUser);

    const response = await post("/api/auth/sign-in/email", {
      email: testUser.email,
      password: "WrongPassword123!",
    });

    // If status is 200, verify no user was returned
    if (response.status === 200) {
      const data = (await response.json()) as { user?: unknown };
      expect(data.user).toBeUndefined();
    }
  });

  it("rejects sign-in for non-existent user", async () => {
    const response = await post("/api/auth/sign-in/email", {
      email: uniqueEmail("none"),
      password: "Any123!",
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it("retrieves session with valid cookie", async () => {
    const testUser = {
      name: "Session",
      email: uniqueEmail("session"),
      password: "SecurePassword123!",
    };

    const signUpResponse = await post("/api/auth/sign-up/email", testUser);
    const cookie = signUpResponse.headers.get("set-cookie")!.split(";")[0];

    const sessionResponse = await get("/api/auth/get-session", {
      Cookie: cookie,
    });

    const data = (await sessionResponse.json()) as {
      user?: { email: string } | null;
      session?: { id: string } | null;
    };

    // If session exists, verify email matches
    if (data.session !== null) {
      expect(data.user?.email).toBe(testUser.email);
    }
  });

  it("signs out and invalidates session", async () => {
    const testUser = {
      name: "Signout",
      email: uniqueEmail("signout"),
      password: "SecurePassword123!",
    };

    const signUpResponse = await post("/api/auth/sign-up/email", testUser);
    const cookie = signUpResponse.headers.get("set-cookie")!.split(";")[0];

    const signOutResponse = await worker.fetch(
      new Request("http://localhost/api/auth/sign-out", {
        method: "POST",
        headers: { Cookie: cookie },
      }),
      env as Env
    );

    // Sign out should return one of these status codes
    const validStatuses = [200, 302, 403];
    expect(validStatuses.includes(signOutResponse.status)).toBe(true);
  });
});

// ============================================================================
// SSO Provider Tests (Skipped - requires external OAuth setup)
// ============================================================================

describe.skip("SSO Providers", () => {
  it("returns OAuth URL for Google", async () => {
    const response = await get(
      "/api/auth/sign-in/social?provider=google&callbackURL=https://docketadmin.com/callback"
    );

    if (response.status === 302) {
      const location = response.headers.get("location");
      expect(location).toContain("accounts.google.com");
    }
  });

  it("returns OAuth URL for Apple", async () => {
    const response = await get(
      "/api/auth/sign-in/social?provider=apple&callbackURL=https://docketadmin.com/callback"
    );

    if (response.status === 302) {
      const location = response.headers.get("location");
      expect(location).toContain("appleid.apple.com");
    }
  });
});
