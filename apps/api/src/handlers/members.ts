import type { MemberContext, AdminContext, AuthContext } from "../lib/session";
import { logAuthzFailure } from "../lib/logger";
import type { Env } from "../types/env";
import type { OrgRole } from "../types";
import { getOrgMembership, removeUserFromOrg, transferOwnership } from "../services/org-membership";
import {
  inviteUser,
  getOrgInvitations,
  revokeInvitation,
  hasPendingInvitation,
  getInvitationById,
  acceptInvitationById,
} from "../services/invitations";
import { errors, errorResponse, getStatusForError } from "../lib/errors";

// -----------------------------------------------------------------------------
// Helper Functions
// -----------------------------------------------------------------------------

async function parseJsonBody<T>(request: Request): Promise<T | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function isValidRole(role: unknown): role is OrgRole {
  return role === "admin" || role === "member";
}

interface MemberRow {
  id: string;
  user_id: string;
  email: string;
  name: string;
  role: OrgRole;
  is_owner: number;
  created_at: number;
}

function formatMemberResponse(row: MemberRow) {
  return {
    id: row.id,
    userId: row.user_id,
    email: row.email,
    name: row.name,
    role: row.role,
    isOwner: row.is_owner === 1,
    createdAt: row.created_at,
  };
}

// -----------------------------------------------------------------------------
// Member Management Handlers
// -----------------------------------------------------------------------------

/**
 * GET /org/members
 * Returns all members of the organization.
 */
export async function handleGetMembers(
  _request: Request,
  env: Env,
  ctx: MemberContext
): Promise<Response> {
  const query = `
    SELECT om.id, om.user_id, u.email, u.name, om.role, om.is_owner, om.created_at
    FROM org_members om
    JOIN user u ON u.id = om.user_id
    WHERE om.org_id = ?
    ORDER BY om.created_at
  `;

  const { results } = await env.DB.prepare(query)
    .bind(ctx.orgId)
    .all<MemberRow>();

  const members = results.map(formatMemberResponse);
  return Response.json(members);
}

/**
 * DELETE /org/members/:userId
 * Remove a member from the organization.
 */
export async function handleRemoveMember(
  _request: Request,
  env: Env,
  ctx: AdminContext,
  targetUserId: string
): Promise<Response> {
  if (targetUserId === ctx.user.id) {
    return errorResponse(400, "Cannot remove yourself. Use leave organization instead.", "CANNOT_REMOVE_SELF");
  }

  const result = await removeUserFromOrg(env.DB, targetUserId, ctx.orgId, env.TENANT);

  if (result.success === false) {
    const status = getStatusForError(result.error);
    return errorResponse(status, result.message, "INVALID_REQUEST");
  }

  return Response.json({ success: true });
}

/**
 * PATCH /org/members/:userId
 * Update a member's role.
 */
export async function handleUpdateMemberRole(
  request: Request,
  env: Env,
  ctx: AdminContext,
  targetUserId: string
): Promise<Response> {
  const body = await parseJsonBody<{ role?: OrgRole }>(request);
  if (!body) {
    return errors.invalidJson();
  }

  if (!isValidRole(body.role)) {
    return errorResponse(400, "Role must be 'admin' or 'member'", "INVALID_FIELD");
  }

  const targetMembership = await getOrgMembership(env.DB, targetUserId, ctx.orgId);
  if (!targetMembership) {
    return errors.notFound("User");
  }

  if (targetMembership.isOwner) {
    return errorResponse(400, "Cannot change the owner's role", "CANNOT_MODIFY_OWNER");
  }

  // Update the role
  await env.DB.prepare(`UPDATE org_members SET role = ? WHERE user_id = ? AND org_id = ?`)
    .bind(body.role, targetUserId, ctx.orgId)
    .run();

  return Response.json({ success: true, role: body.role });
}

/**
 * POST /org/transfer-ownership
 * Transfer organization ownership to another admin.
 */
export async function handleTransferOwnership(
  request: Request,
  env: Env,
  ctx: AdminContext
): Promise<Response> {
  if (!ctx.isOwner) {
    logAuthzFailure("transferOwnership", "Not owner", {
      userId: ctx.user.id,
      orgId: ctx.orgId,
    });
    return errorResponse(403, "Only the owner can transfer ownership", "NOT_OWNER");
  }

  const body = await parseJsonBody<{ toUserId?: string; confirmName?: string }>(request);
  if (!body) {
    return errors.invalidJson();
  }

  if (!body.toUserId) {
    return errors.missingField("Target user ID");
  }

  if (!body.confirmName) {
    return errors.missingField("Organization name confirmation");
  }

  const org = await env.DB.prepare(`SELECT name FROM org WHERE id = ?`)
    .bind(ctx.orgId)
    .first<{ name: string }>();

  if (!org || body.confirmName !== org.name) {
    return errorResponse(400, "Name does not match", "NAME_MISMATCH");
  }

  const result = await transferOwnership(env.DB, ctx.orgId, ctx.user.id, body.toUserId);

  if (result.success === false) {
    const status = getStatusForError(result.error);
    return errorResponse(status, result.message, "INVALID_REQUEST");
  }

  return Response.json({ success: true });
}

// -----------------------------------------------------------------------------
// Invitation Handlers
// -----------------------------------------------------------------------------

/**
 * POST /org/invitations
 * Send an invitation to join the organization.
 */
export async function handleSendInvitation(
  request: Request,
  env: Env,
  ctx: AdminContext
): Promise<Response> {
  const body = await parseJsonBody<{ email?: string; role?: OrgRole }>(request);
  if (!body) {
    return errors.invalidJson();
  }

  const email = body.email?.toLowerCase().trim();
  if (!email || !email.includes("@")) {
    return errorResponse(400, "Valid email is required", "INVALID_FIELD");
  }

  if (!isValidRole(body.role)) {
    return errorResponse(400, "Role must be 'admin' or 'member'", "INVALID_FIELD");
  }

  const existingMember = await env.DB.prepare(
    `SELECT 1 FROM org_members om
     JOIN user u ON u.id = om.user_id
     WHERE u.email = ? AND om.org_id = ?`
  )
    .bind(email, ctx.orgId)
    .first();

  if (existingMember) {
    return errorResponse(400, "This user is already a member of your organization", "ALREADY_MEMBER");
  }

  const hasPending = await hasPendingInvitation(env.DB, email, ctx.orgId);
  if (hasPending) {
    return errorResponse(400, "A pending invitation already exists for this email", "ALREADY_EXISTS");
  }

  const org = await env.DB.prepare(`SELECT name FROM org WHERE id = ?`)
    .bind(ctx.orgId)
    .first<{ name: string }>();

  if (!org) {
    return errors.notFound("Organization");
  }

  // Send the invitation
  const result = await inviteUser(env, env.DB, {
    email,
    orgId: ctx.orgId,
    orgName: org.name,
    role: body.role,
    invitedBy: ctx.user.id,
    inviterName: ctx.user.name,
  });

  return Response.json({
    id: result.id,
    email,
    role: body.role,
    expiresAt: result.expiresAt,
    emailError: result.emailError,
  });
}

/**
 * GET /org/invitations
 * Returns all pending invitations for the organization.
 */
export async function handleGetInvitations(
  _request: Request,
  env: Env,
  ctx: AdminContext
): Promise<Response> {
  const invitations = await getOrgInvitations(env.DB, ctx.orgId);

  // Collect unique inviter IDs to fetch their names
  const inviterIds = Array.from(new Set(invitations.map((inv) => inv.invitedBy)));
  const inviterNames = new Map<string, string>();

  if (inviterIds.length > 0) {
    const placeholders = inviterIds.map(() => "?").join(",");
    const query = `SELECT id, name FROM user WHERE id IN (${placeholders})`;

    const { results } = await env.DB.prepare(query)
      .bind(...inviterIds)
      .all<{ id: string; name: string }>();

    for (const user of results) {
      inviterNames.set(user.id, user.name);
    }
  }

  // Format the response
  const formattedInvitations = invitations.map((inv) => ({
    id: inv.id,
    email: inv.email,
    role: inv.role,
    invitedBy: inv.invitedBy,
    inviterName: inviterNames.get(inv.invitedBy) || "Unknown",
    createdAt: inv.createdAt,
    expiresAt: inv.expiresAt,
  }));

  return Response.json(formattedInvitations);
}

/**
 * DELETE /org/invitations/:invitationId
 * Revoke a pending invitation.
 */
export async function handleRevokeInvitation(
  _request: Request,
  env: Env,
  ctx: AdminContext,
  invitationId: string
): Promise<Response> {
  const invitation = await env.DB.prepare(`SELECT org_id FROM invitations WHERE id = ?`)
    .bind(invitationId)
    .first<{ org_id: string }>();

  if (!invitation || invitation.org_id !== ctx.orgId) {
    return errors.notFound("Invitation");
  }

  const revoked = await revokeInvitation(env.DB, invitationId);

  if (!revoked) {
    return errorResponse(404, "Invitation not found or already accepted", "INVITATION_NOT_FOUND");
  }

  return Response.json({ success: true });
}

/**
 * GET /invitations/:invitationId
 * Get invitation details (public, for the invitation accept page).
 */
export async function handleGetInvitation(
  _request: Request,
  env: Env,
  invitationId: string
): Promise<Response> {
  const invitation = await getInvitationById(env.DB, invitationId);

  if (!invitation) {
    return errors.notFound("Invitation");
  }

  return Response.json({
    id: invitation.id,
    email: invitation.email,
    orgName: invitation.orgName,
    role: invitation.role,
    inviterName: invitation.inviterName,
    isExpired: invitation.isExpired,
    isAccepted: invitation.isAccepted,
  });
}

/**
 * POST /invitations/:invitationId/accept
 * Accept an invitation to join an organization.
 */
export async function handleAcceptInvitation(
  _request: Request,
  env: Env,
  ctx: AuthContext,
  invitationId: string
): Promise<Response> {
  const existingMembership = await env.DB.prepare(
    `SELECT org_id FROM org_members WHERE user_id = ?`
  )
    .bind(ctx.user.id)
    .first<{ org_id: string }>();

  if (existingMembership) {
    return errorResponse(400, "You already belong to an organization", "ALREADY_MEMBER");
  }

  const invitation = await getInvitationById(env.DB, invitationId);

  if (!invitation) {
    return errors.notFound("Invitation");
  }

  if (invitation.isAccepted) {
    return errorResponse(400, "This invitation has already been accepted", "INVITATION_ACCEPTED");
  }

  if (invitation.isExpired) {
    return errorResponse(400, "This invitation has expired", "INVITATION_EXPIRED");
  }

  const userEmail = ctx.user.email.toLowerCase();
  const invitationEmail = invitation.email.toLowerCase();

  if (userEmail !== invitationEmail) {
    logAuthzFailure("acceptInvitation", "Email mismatch", {
      userId: ctx.user.id,
      email: ctx.user.email,
    });
    return errorResponse(
      403,
      "This invitation was sent to a different email address. Please log in with the correct account.",
      "EMAIL_MISMATCH"
    );
  }

  const result = await acceptInvitationById(env.DB, invitationId, ctx.user.id);

  if (!result) {
    return errors.internal("Failed to accept invitation");
  }

  return Response.json({
    success: true,
    orgId: result.orgId,
    role: result.role,
  });
}
