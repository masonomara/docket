import type { Env } from "../types/env";
import { errors } from "../lib/errors";

/**
 * Checks if an email exists in the system and whether they have a password set.
 * Used by the auth flow to determine which step to show (login vs signup vs oauth-only).
 */
export async function handleCheckEmail(
  request: Request,
  env: Env
): Promise<Response> {
  if (request.method !== "POST") {
    return errors.methodNotAllowed();
  }

  let body: { email?: string };
  try {
    body = (await request.json()) as { email?: string };
  } catch {
    return errors.invalidJson();
  }

  const email = body.email?.toLowerCase().trim();
  if (!email) {
    return errors.missingField("Email");
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
