import type { AuthContext } from "../lib/session";
import type { Env } from "../types/env";
import { getDataDeletionPreview, deleteUserData } from "../services/gdpr";
import { errors, errorResponse } from "../lib/errors";

// -----------------------------------------------------------------------------
// Account Handlers
// -----------------------------------------------------------------------------

/**
 * GET /account/deletion-preview
 * Returns a preview of what data will be deleted if the user deletes their account.
 */
export async function handleGetAccountDeletionPreview(
  _request: Request,
  env: Env,
  ctx: AuthContext
): Promise<Response> {
  const preview = await getDataDeletionPreview(env.DB, ctx.user.id);
  return Response.json(preview);
}

/**
 * PATCH /account
 * Update the user's account information.
 */
export async function handleUpdateAccount(
  request: Request,
  env: Env,
  ctx: AuthContext
): Promise<Response> {
  let body: { name?: string };
  try {
    body = await request.json();
  } catch {
    return errors.invalidJson();
  }

  if (body.name === undefined) {
    return errorResponse(400, "No fields to update", "INVALID_REQUEST");
  }

  const trimmedName = body.name.trim();

  if (trimmedName.length === 0) {
    return errorResponse(400, "Name cannot be empty", "INVALID_FIELD");
  }

  if (trimmedName.length > 100) {
    return errorResponse(400, "Name must be 100 characters or less", "INVALID_FIELD");
  }

  // Update the user record
  await env.DB.prepare("UPDATE user SET name = ?, updated_at = ? WHERE id = ?")
    .bind(trimmedName, Date.now(), ctx.user.id)
    .run();

  return Response.json({ success: true, name: trimmedName });
}

/**
 * DELETE /account
 * Delete the user's account and all associated data.
 */
export async function handleDeleteAccount(
  request: Request,
  env: Env,
  ctx: AuthContext
): Promise<Response> {
  let body: { confirmEmail?: string };
  try {
    body = await request.json();
  } catch {
    return errors.invalidJson();
  }

  if (!body.confirmEmail || body.confirmEmail !== ctx.user.email) {
    return errorResponse(400, "Email does not match", "EMAIL_MISMATCH");
  }

  // Attempt to delete all user data
  const result = await deleteUserData(
    env.DB,
    env.R2,
    env.VECTORIZE,
    ctx.user.id,
    env.TENANT
  );

  if ("type" in result && result.type === "sole_owner") {
    return errorResponse(400, result.message, "SOLE_OWNER", {
      orgIds: result.orgIds,
    });
  }

  return Response.json(result);
}
