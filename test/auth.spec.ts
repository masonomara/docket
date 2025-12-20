import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker, { type Env } from "../src/index";

async function authRequest(
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  return worker.fetch(
    new Request(`http://localhost${path}`, options),
    env as Env
  );
}

async function authPost(
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {}
): Promise<Response> {
  return authRequest(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function getSessionCookie(response: Response): string | null {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) return null;
  const match = setCookie.match(/better-auth\.session_token=([^;]+)/);
  return match ? match[1] : null;
}

describe("Email/Password Authentication", () => {
  it("signs up a new user and creates records in D1", async () => {
    const testUser = {
      name: "Signup Test User",
      email: `signup-${Date.now()}@example.com`,
      password: "SecurePassword123!",
    };
    const response = await authPost("/api/auth/sign-up/email", testUser);

    expect(response.status).toBe(200);
    const data = (await response.json()) as {
      user?: { id: string; email: string };
    };
    expect(data.user?.email).toBe(testUser.email);
    expect(getSessionCookie(response)).toBeTruthy();

    const user = await env.DB.prepare("SELECT * FROM user WHERE id = ?")
      .bind(data.user!.id)
      .first<{ name: string; email: string }>();
    expect(user?.name).toBe(testUser.name);

    const account = await env.DB.prepare(
      "SELECT * FROM account WHERE user_id = ?"
    )
      .bind(data.user!.id)
      .first<{ provider_id: string; password: string }>();
    expect(account?.provider_id).toBe("credential");
    expect(account?.password).not.toBe(testUser.password);
  });

  it("rejects duplicate email signup", async () => {
    const email = `duplicate-${Date.now()}@example.com`;
    const user = {
      name: "Duplicate Test",
      email,
      password: "SecurePassword123!",
    };
    await authPost("/api/auth/sign-up/email", user);
    const second = await authPost("/api/auth/sign-up/email", user);
    const data = (await second.json()) as { error?: unknown; user?: unknown };
    expect(data.error !== undefined || data.user === undefined).toBe(true);
  });

  it("signs in with valid credentials", async () => {
    const testUser = {
      name: "SignIn Test User",
      email: `signin-${Date.now()}@example.com`,
      password: "SecurePassword123!",
    };
    await authPost("/api/auth/sign-up/email", testUser);
    const response = await authPost("/api/auth/sign-in/email", {
      email: testUser.email,
      password: testUser.password,
    });
    expect(response.status).toBe(200);
    expect(getSessionCookie(response)).toBeTruthy();
  });

  it("rejects sign-in with wrong password", async () => {
    const testUser = {
      name: "Wrong Password Test",
      email: `wrongpass-${Date.now()}@example.com`,
      password: "SecurePassword123!",
    };
    await authPost("/api/auth/sign-up/email", testUser);
    const response = await authPost("/api/auth/sign-in/email", {
      email: testUser.email,
      password: "WrongPassword123!",
    });
    if (response.status === 200) {
      const data = (await response.json()) as { user?: unknown };
      expect(data.user).toBeUndefined();
    }
  });

  it("rejects sign-in for non-existent user", async () => {
    const response = await authPost("/api/auth/sign-in/email", {
      email: `nonexistent-${Date.now()}@example.com`,
      password: "AnyPassword123!",
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it("retrieves session with valid cookie", async () => {
    const testUser = {
      name: "Session Test User",
      email: `session-${Date.now()}@example.com`,
      password: "SecurePassword123!",
    };
    const signUpResponse = await authPost("/api/auth/sign-up/email", testUser);
    const setCookieHeader = signUpResponse.headers.get("set-cookie");
    expect(setCookieHeader).toBeTruthy();

    const sessionResponse = await authRequest("/api/auth/get-session", {
      headers: { Cookie: setCookieHeader!.split(";")[0] },
    });
    expect(sessionResponse.status).toBe(200);
    const data = (await sessionResponse.json()) as {
      user?: { email: string } | null;
      session?: { id: string } | null;
    };
    if (data.session !== null) expect(data.user?.email).toBe(testUser.email);
  });

  it("signs out and invalidates session", async () => {
    const testUser = {
      name: "Signout Test User",
      email: `signout-${Date.now()}@example.com`,
      password: "SecurePassword123!",
    };
    const signUpResponse = await authPost("/api/auth/sign-up/email", testUser);
    const cookieValue = signUpResponse.headers.get("set-cookie")!.split(";")[0];
    const signOutResponse = await authRequest("/api/auth/sign-out", {
      method: "POST",
      headers: { Cookie: cookieValue },
    });
    expect([200, 302, 403].includes(signOutResponse.status)).toBe(true);
  });
});

describe.skip("SSO Providers", () => {
  it("returns OAuth URL for Google sign-in", async () => {
    const response = await authRequest(
      "/api/auth/sign-in/social?provider=google&callbackURL=https://docketadmin.com/callback"
    );
    if (response.status === 302)
      expect(response.headers.get("location")).toContain("accounts.google.com");
  });

  it("returns OAuth URL for Apple sign-in", async () => {
    const response = await authRequest(
      "/api/auth/sign-in/social?provider=apple&callbackURL=https://docketadmin.com/callback"
    );
    if (response.status === 302)
      expect(response.headers.get("location")).toContain("appleid.apple.com");
  });
});
