export type OrgRole = "admin" | "member";

export interface OrgMembership {
  id: string;
  userId: string;
  orgId: string;
  role: OrgRole;
  isOwner: boolean;
  createdAt: number;
}

export interface RemoveFromOrgResult {
  success: boolean;
  error?: "user_not_member" | "is_owner" | "db_error";
  message?: string;
}

export interface TransferOwnershipResult {
  success: boolean;
  error?: "not_owner" | "target_not_member" | "target_not_admin" | "db_error";
  message?: string;
}

/**
 * Gets a user's membership in an organization.
 */
export async function getOrgMembership(
  db: D1Database,
  userId: string,
  orgId: string
): Promise<OrgMembership | null> {
  const result = await db
    .prepare(
      `SELECT id, user_id, org_id, role, is_owner, created_at
       FROM org_members
       WHERE user_id = ? AND org_id = ?`
    )
    .bind(userId, orgId)
    .first<{
      id: string;
      user_id: string;
      org_id: string;
      role: OrgRole;
      is_owner: number;
      created_at: number;
    }>();

  if (!result) {
    return null;
  }

  return {
    id: result.id,
    userId: result.user_id,
    orgId: result.org_id,
    role: result.role,
    isOwner: result.is_owner === 1,
    createdAt: result.created_at,
  };
}

/**
 * Lists all members of an organization.
 */
export async function getOrgMembers(
  db: D1Database,
  orgId: string
): Promise<OrgMembership[]> {
  const result = await db
    .prepare(
      `SELECT id, user_id, org_id, role, is_owner, created_at
       FROM org_members
       WHERE org_id = ?
       ORDER BY created_at ASC`
    )
    .bind(orgId)
    .all<{
      id: string;
      user_id: string;
      org_id: string;
      role: OrgRole;
      is_owner: number;
      created_at: number;
    }>();

  return result.results.map((row) => ({
    id: row.id,
    userId: row.user_id,
    orgId: row.org_id,
    role: row.role,
    isOwner: row.is_owner === 1,
    createdAt: row.created_at,
  }));
}

/**
 * Removes a user from an organization.
 * Owner cannot leave - must transfer ownership first.
 *
 * TODO Phase 6: Call DO to expire pending_confirmations and delete Clio token
 */
export async function removeUserFromOrg(
  db: D1Database,
  userId: string,
  orgId: string
): Promise<RemoveFromOrgResult> {
  const membership = await getOrgMembership(db, userId, orgId);

  if (!membership) {
    return {
      success: false,
      error: "user_not_member",
      message: "User is not a member of this organization.",
    };
  }

  if (membership.isOwner) {
    return {
      success: false,
      error: "is_owner",
      message: "Owner cannot leave. Transfer ownership first.",
    };
  }

  try {
    await db
      .prepare(`DELETE FROM org_members WHERE user_id = ? AND org_id = ?`)
      .bind(userId, orgId)
      .run();

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: "db_error",
      message: `Database error: ${error}`,
    };
  }
}

/**
 * Transfers ownership from current owner to another admin.
 * Target must be an existing admin in the organization.
 */
export async function transferOwnership(
  db: D1Database,
  orgId: string,
  fromUserId: string,
  toUserId: string
): Promise<TransferOwnershipResult> {
  const currentOwner = await getOrgMembership(db, fromUserId, orgId);

  if (!currentOwner || !currentOwner.isOwner) {
    return {
      success: false,
      error: "not_owner",
      message: "Only the current owner can transfer ownership.",
    };
  }

  const targetMember = await getOrgMembership(db, toUserId, orgId);

  if (!targetMember) {
    return {
      success: false,
      error: "target_not_member",
      message: "Target user is not a member of this organization.",
    };
  }

  if (targetMember.role !== "admin") {
    return {
      success: false,
      error: "target_not_admin",
      message: "Ownership can only be transferred to an admin.",
    };
  }

  try {
    await db.batch([
      db
        .prepare(
          `UPDATE org_members SET is_owner = 0 WHERE user_id = ? AND org_id = ?`
        )
        .bind(fromUserId, orgId),
      db
        .prepare(
          `UPDATE org_members SET is_owner = 1 WHERE user_id = ? AND org_id = ?`
        )
        .bind(toUserId, orgId),
    ]);

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: "db_error",
      message: `Database error: ${error}`,
    };
  }
}
