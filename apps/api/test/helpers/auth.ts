/**
 * Shared authentication helpers for integration tests.
 */

import type { Env } from "../../src/index";
import { uniqueEmail } from "./fixtures";
import { getSessionCookie } from "./requests";

type WorkerFetch = {
  fetch: (request: Request, env: Env) => Promise<Response>;
};

/**
 * Signs up a new user and returns their session cookie.
 */
export async function signUpUser(
  worker: WorkerFetch,
  env: Env,
  options: {
    email?: string;
    name?: string;
    password?: string;
  } = {}
): Promise<{ userId: string; email: string; cookie: string }> {
  const email = options.email ?? uniqueEmail("signup");
  const name = options.name ?? "Test User";
  const password = options.password ?? "SecurePassword123!";

  const response = await worker.fetch(
    new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, password }),
    }),
    env
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Sign up failed: ${response.status} - ${text}`);
  }

  const data = (await response.json()) as { user?: { id: string } };
  const cookie = getSessionCookie(response);

  if (!data.user?.id || !cookie) {
    throw new Error("Sign up succeeded but missing user ID or session cookie");
  }

  return { userId: data.user.id, email, cookie };
}

/**
 * Signs in an existing user and returns their session cookie.
 */
export async function signInUser(
  worker: WorkerFetch,
  env: Env,
  options: {
    email: string;
    password: string;
  }
): Promise<{ userId: string; cookie: string }> {
  const response = await worker.fetch(
    new Request("http://localhost/api/auth/sign-in/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: options.email,
        password: options.password,
      }),
    }),
    env
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Sign in failed: ${response.status} - ${text}`);
  }

  const data = (await response.json()) as { user?: { id: string } };
  const cookie = getSessionCookie(response);

  if (!data.user?.id || !cookie) {
    throw new Error("Sign in succeeded but missing user ID or session cookie");
  }

  return { userId: data.user.id, cookie };
}

/**
 * Verifies a session cookie is valid by calling get-session.
 */
export async function verifySession(
  worker: WorkerFetch,
  env: Env,
  cookie: string
): Promise<boolean> {
  const response = await worker.fetch(
    new Request("http://localhost/api/auth/get-session", {
      headers: { Cookie: cookie },
    }),
    env
  );

  if (!response.ok) return false;

  const data = (await response.json()) as { session?: unknown };
  return !!data.session;
}

/**
 * Creates a user with session and optionally adds them to an org.
 * Combines signup with org membership for common test setup.
 */
export async function createUserWithSession(
  worker: WorkerFetch,
  env: Env,
  db: D1Database,
  options: {
    email?: string;
    name?: string;
    orgId?: string;
    orgRole?: "admin" | "member";
  } = {}
): Promise<{ userId: string; email: string; cookie: string }> {
  const { userId, email, cookie } = await signUpUser(worker, env, {
    email: options.email,
    name: options.name,
  });

  if (options.orgId) {
    const memberId = crypto.randomUUID();
    const now = Date.now();
    const role = options.orgRole ?? "member";
    const isOwner = role === "admin" ? 1 : 0;

    await db
      .prepare(
        `INSERT OR IGNORE INTO org_members (id, org_id, user_id, role, is_owner, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(memberId, options.orgId, userId, role, isOwner, now)
      .run();
  }

  return { userId, email, cookie };
}
