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

  return worker.fetch(request, env as unknown as Env);
}

/**
 * Makes a GET request to the worker
 */
async function get(
  path: string,
  headers: Record<string, string> = {}
): Promise<Response> {
  const request = new Request(`http://localhost${path}`, { headers });
  return worker.fetch(request, env as unknown as Env);
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

/**
 * Marks a user as email-verified in the database.
 * Required because email verification is enabled in production config.
 */
async function verifyUserEmail(userId: string): Promise<void> {
  await env.DB.prepare("UPDATE user SET email_verified = 1 WHERE id = ?")
    .bind(userId)
    .run();
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

    // No session cookie until email is verified (email verification is enabled)
    // This is expected behavior - user must verify email first

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
    const signUpResponse = await post("/api/auth/sign-up/email", testUser);
    const signUpData = (await signUpResponse.json()) as {
      user?: { id: string };
    };

    // Manually verify email (required for sign-in)
    await verifyUserEmail(signUpData.user!.id);

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

    // Sign up and verify email
    const signUpResponse = await post("/api/auth/sign-up/email", testUser);
    const signUpData = (await signUpResponse.json()) as {
      user?: { id: string };
    };
    await verifyUserEmail(signUpData.user!.id);

    // Sign in to get session cookie
    const signInResponse = await post("/api/auth/sign-in/email", {
      email: testUser.email,
      password: testUser.password,
    });
    const cookie = signInResponse.headers.get("set-cookie")!.split(";")[0];

    const sessionResponse = await get("/api/auth/get-session", {
      Cookie: cookie,
    });

    const data = (await sessionResponse.json()) as {
      user?: { email: string } | null;
      session?: { id: string } | null;
    };

    expect(data.session).not.toBeNull();
    expect(data.user?.email).toBe(testUser.email);
  });

  it("signs out without error", async () => {
    const testUser = {
      name: "Signout",
      email: uniqueEmail("signout"),
      password: "SecurePassword123!",
    };

    // Sign up and verify email
    const signUpResponse = await post("/api/auth/sign-up/email", testUser);
    const signUpData = (await signUpResponse.json()) as {
      user?: { id: string };
    };
    await verifyUserEmail(signUpData.user!.id);

    // Sign in to get session cookie
    const signInResponse = await post("/api/auth/sign-in/email", {
      email: testUser.email,
      password: testUser.password,
    });
    const cookie = signInResponse.headers.get("set-cookie")!.split(";")[0];

    // Sign out should not throw
    const signOutResponse = await worker.fetch(
      new Request("http://localhost/api/auth/sign-out", {
        method: "POST",
        headers: { Cookie: cookie },
      }),
      env as unknown as Env
    );

    // Sign out should not return 5xx error
    expect(signOutResponse.status).toBeLessThan(500);
  });
});
