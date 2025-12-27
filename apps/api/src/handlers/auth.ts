import type { Env } from "../types/env";

/**
 * Checks if an email exists in the system and whether they have a password set.
 * Used by the auth flow to determine which step to show (login vs signup vs oauth-only).
 */
export async function handleCheckEmail(
  request: Request,
  env: Env
): Promise<Response> {
  // Only accept POST requests
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  // Parse the request body
  let body: { email?: string };
  try {
    body = (await request.json()) as { email?: string };
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Validate email is present
  const email = body.email?.toLowerCase().trim();
  if (!email) {
    return Response.json({ error: "Email is required" }, { status: 400 });
  }

  // Look up the user
  const user = await env.DB.prepare(
    "SELECT id FROM user WHERE email = ? LIMIT 1"
  )
    .bind(email)
    .first<{ id: string }>();

  // User doesn't exist - they need to sign up
  if (!user) {
    return Response.json({ exists: false, hasPassword: false });
  }

  // User exists - check if they have a password (credential account) or just OAuth
  const hasCredentialAccount = await env.DB.prepare(
    "SELECT id FROM account WHERE user_id = ? AND provider_id = 'credential' LIMIT 1"
  )
    .bind(user.id)
    .first<{ id: string }>();

  return Response.json({
    exists: true,
    hasPassword: hasCredentialAccount !== null,
  });
}
