import type { AuthContext, AdminContext, OwnerContext } from "../lib/session";
import type { Env } from "../types/env";
import type { OrgMemberRow } from "../types";
import { orgMemberRowToEntity } from "../types";
import { getOrgDeletionPreview, deleteOrg } from "../services/org-deletion";
import { createLogger, generateRequestId } from "../lib/logger";
import { errors, errorResponse } from "../lib/errors";

// -----------------------------------------------------------------------------
// Helper Functions
// -----------------------------------------------------------------------------

/**
 * Safely parse a JSON string, returning an empty array on failure.
 */
function safeParseJsonArray(jsonString: string | null): string[] {
  if (!jsonString) {
    return [];
  }
  try {
    return JSON.parse(jsonString);
  } catch {
    return [];
  }
}

// -----------------------------------------------------------------------------
// Organization Handlers
// -----------------------------------------------------------------------------

/**
 * POST /org
 * Create a new organization. The creating user becomes the owner.
 */
export async function handleCreateOrg(
  request: Request,
  env: Env,
  ctx: AuthContext
): Promise<Response> {
  const existingMembership = await env.DB.prepare(
    "SELECT org_id FROM org_members WHERE user_id = ?"
  )
    .bind(ctx.user.id)
    .first();

  if (existingMembership) {
    return errorResponse(400, "User already belongs to an organization", "ALREADY_MEMBER");
  }

  let body: {
    name?: string;
    firmSize?: string;
    jurisdictions?: string[];
    practiceTypes?: string[];
    orgType?: string;
  };

  try {
    body = await request.json();
  } catch {
    return errors.invalidJson();
  }

  const orgName = body.name?.trim();
  if (!orgName) {
    return errors.missingField("Organization name");
  }

  // Generate IDs and timestamp
  const orgId = crypto.randomUUID();
  const memberId = crypto.randomUUID();
  const now = Date.now();

  const log = createLogger({
    requestId: generateRequestId(),
    handler: "create-org",
    userId: ctx.user.id,
  });

  try {
    // Create org and membership in a single transaction
    const createOrgStatement = env.DB.prepare(
      `INSERT INTO org (id, name, jurisdictions, practice_types, firm_size, org_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      orgId,
      orgName,
      body.jurisdictions ? JSON.stringify(body.jurisdictions) : null,
      body.practiceTypes ? JSON.stringify(body.practiceTypes) : null,
      body.firmSize || null,
      body.orgType || "law-firm",
      now,
      now
    );

    const createMemberStatement = env.DB.prepare(
      `INSERT INTO org_members (id, user_id, org_id, role, is_owner, created_at)
       VALUES (?, ?, ?, 'admin', 1, ?)`
    ).bind(memberId, ctx.user.id, orgId, now);

    await env.DB.batch([createOrgStatement, createMemberStatement]);

    return Response.json({
      org: { id: orgId, name: orgName },
      membership: { role: "admin", isOwner: true },
    });
  } catch (error) {
    log.error("Failed to create org", { error });
    return errors.internal("Failed to create organization");
  }
}

/**
 * GET /org
 * Get the current user's organization and membership details.
 */
export async function handleGetUserOrg(
  _request: Request,
  env: Env,
  ctx: AuthContext
): Promise<Response> {
  const query = `
    SELECT
      om.id, om.user_id, om.org_id, om.role, om.is_owner, om.created_at,
      o.name as org_name,
      o.jurisdictions as org_jurisdictions,
      o.practice_types as org_practice_types,
      o.firm_size as org_firm_size,
      o.org_type as org_type
    FROM org_members om
    JOIN org o ON o.id = om.org_id
    WHERE om.user_id = ?
  `;

  type OrgMemberWithOrg = OrgMemberRow & {
    org_name: string;
    org_jurisdictions: string | null;
    org_practice_types: string | null;
    org_firm_size: string | null;
    org_type: string | null;
  };

  const row = await env.DB.prepare(query)
    .bind(ctx.user.id)
    .first<OrgMemberWithOrg>();

  // User doesn't belong to any organization
  if (!row) {
    return Response.json(null);
  }

  const membership = orgMemberRowToEntity(row);

  return Response.json({
    org: {
      id: membership.orgId,
      name: row.org_name,
      jurisdictions: safeParseJsonArray(row.org_jurisdictions),
      practiceTypes: safeParseJsonArray(row.org_practice_types),
      firmSize: row.org_firm_size || undefined,
      orgType: row.org_type || "law-firm",
    },
    role: membership.role,
    isOwner: membership.isOwner,
  });
}

/**
 * PATCH /org
 * Update organization settings. Requires admin role.
 */
export async function handleUpdateOrg(
  request: Request,
  env: Env,
  ctx: AdminContext
): Promise<Response> {
  let body: {
    name?: string;
    jurisdictions?: string[];
    practiceTypes?: string[];
    firmSize?: string;
    orgType?: string;
  };

  try {
    body = await request.json();
  } catch {
    return errors.invalidJson();
  }

  const updates: string[] = [];
  const values: (string | null)[] = [];

  if (body.name !== undefined) {
    const trimmedName = body.name.trim();
    if (!trimmedName) {
      return errorResponse(400, "Name cannot be empty", "INVALID_FIELD");
    }
    updates.push("name = ?");
    values.push(trimmedName);
  }

  // Add jurisdictions update
  if (body.jurisdictions !== undefined) {
    updates.push("jurisdictions = ?");
    values.push(JSON.stringify(body.jurisdictions));
  }

  // Add practice types update
  if (body.practiceTypes !== undefined) {
    updates.push("practice_types = ?");
    values.push(JSON.stringify(body.practiceTypes));
  }

  // Add firm size update
  if (body.firmSize !== undefined) {
    updates.push("firm_size = ?");
    values.push(body.firmSize || null);
  }

  // Add org type update
  if (body.orgType !== undefined) {
    updates.push("org_type = ?");
    values.push(body.orgType || "law-firm");
  }

  if (updates.length === 0) {
    return errorResponse(400, "No fields to update", "INVALID_REQUEST");
  }

  // Add updated_at timestamp
  updates.push("updated_at = ?");
  values.push(String(Date.now()));

  // Add org ID for WHERE clause
  values.push(ctx.orgId);

  const log = createLogger({
    requestId: generateRequestId(),
    handler: "update-org",
    orgId: ctx.orgId,
  });

  try {
    const updateQuery = `UPDATE org SET ${updates.join(", ")} WHERE id = ?`;
    await env.DB.prepare(updateQuery).bind(...values).run();
    return Response.json({ success: true });
  } catch (error) {
    log.error("Failed to update org", { error });
    return errors.internal("Failed to update organization");
  }
}

/**
 * GET /org/deletion-preview
 * Get a preview of what will be deleted if the organization is deleted.
 * Requires owner role.
 */
export async function handleGetOrgDeletionPreview(
  _request: Request,
  env: Env,
  ctx: OwnerContext
): Promise<Response> {
  const preview = await getOrgDeletionPreview(env.DB, ctx.orgId);
  return Response.json(preview);
}

/**
 * DELETE /org
 * Delete the organization and all associated data.
 * Requires owner role and name confirmation.
 */
export async function handleDeleteOrg(
  request: Request,
  env: Env,
  ctx: OwnerContext
): Promise<Response> {
  let body: { confirmName?: string };
  try {
    body = await request.json();
  } catch {
    return errors.invalidJson();
  }

  const org = await env.DB.prepare(`SELECT name FROM org WHERE id = ?`)
    .bind(ctx.orgId)
    .first<{ name: string }>();

  if (!org) {
    return errors.notFound("Organization");
  }

  if (body.confirmName !== org.name) {
    return errorResponse(400, "Organization name does not match", "NAME_MISMATCH");
  }

  const result = await deleteOrg(env.DB, env.R2, ctx.orgId, ctx.user.id, env.TENANT);

  if ("error" in result) {
    return errorResponse(400, result.message, "INVALID_REQUEST");
  }

  return Response.json(result);
}
