export type OrgRole = "admin" | "member";

export interface OrgMembership {
  id: string;
  userId: string;
  orgId: string;
  role: OrgRole;
  isOwner: boolean;
  createdAt: number;
}

interface MemberRow {
  id: string;
  user_id: string;
  org_id: string;
  role: OrgRole;
  is_owner: number;
  created_at: number;
}

function rowToMembership(row: MemberRow): OrgMembership {
  return {
    id: row.id,
    userId: row.user_id,
    orgId: row.org_id,
    role: row.role,
    isOwner: row.is_owner === 1,
    createdAt: row.created_at,
  };
}

export async function getOrgMembership(
  db: D1Database,
  userId: string,
  orgId: string
): Promise<OrgMembership | null> {
  const query = `SELECT * FROM org_members WHERE user_id = ? AND org_id = ?`;
  const row = await db.prepare(query).bind(userId, orgId).first<MemberRow>();

  if (!row) {
    return null;
  }

  return rowToMembership(row);
}

export async function getOrgMembers(
  db: D1Database,
  orgId: string
): Promise<OrgMembership[]> {
  const query = `SELECT * FROM org_members WHERE org_id = ? ORDER BY created_at`;
  const result = await db.prepare(query).bind(orgId).all<MemberRow>();

  return result.results.map(rowToMembership);
}

type RemoveUserResult =
  | { success: true }
  | {
      success: false;
      error: "user_not_member" | "is_owner" | "db_error";
      message: string;
    };

export async function removeUserFromOrg(
  db: D1Database,
  userId: string,
  orgId: string
): Promise<RemoveUserResult> {
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
    const deleteQuery = `DELETE FROM org_members WHERE user_id = ? AND org_id = ?`;
    await db.prepare(deleteQuery).bind(userId, orgId).run();
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: "db_error",
      message: `Database error: ${error}`,
    };
  }
}

type TransferResult =
  | { success: true }
  | {
      success: false;
      error:
        | "not_owner"
        | "target_not_member"
        | "target_not_admin"
        | "db_error";
      message: string;
    };

export async function transferOwnership(
  db: D1Database,
  orgId: string,
  fromUserId: string,
  toUserId: string
): Promise<TransferResult> {
  const currentOwner = await getOrgMembership(db, fromUserId, orgId);

  if (!currentOwner?.isOwner) {
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
    const removeOwnerQuery = `UPDATE org_members SET is_owner = 0 WHERE user_id = ? AND org_id = ?`;
    const setOwnerQuery = `UPDATE org_members SET is_owner = 1 WHERE user_id = ? AND org_id = ?`;

    await db.batch([
      db.prepare(removeOwnerQuery).bind(fromUserId, orgId),
      db.prepare(setOwnerQuery).bind(toUserId, orgId),
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
