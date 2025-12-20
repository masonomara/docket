import { getOrgMembership } from "./org-membership";

async function countRecords(
  db: D1Database,
  table: string,
  orgId: string
): Promise<number> {
  const query = `SELECT COUNT(*) as count FROM ${table} WHERE org_id = ?`;
  const result = await db.prepare(query).bind(orgId).first<{ count: number }>();
  return result?.count ?? 0;
}

export interface OrgDeletionPreview {
  org: { id: string; name: string } | null;
  members: number;
  invitations: number;
  workspaceBindings: number;
  apiKeys: number;
  subscriptions: number;
  orgContextChunks: number;
}

export async function getOrgDeletionPreview(
  db: D1Database,
  orgId: string
): Promise<OrgDeletionPreview> {
  const orgQuery = `SELECT id, name FROM org WHERE id = ?`;

  const [
    org,
    members,
    invitations,
    workspaceBindings,
    apiKeys,
    subscriptions,
    orgContextChunks,
  ] = await Promise.all([
    db.prepare(orgQuery).bind(orgId).first<{ id: string; name: string }>(),
    countRecords(db, "org_members", orgId),
    countRecords(db, "invitations", orgId),
    countRecords(db, "workspace_bindings", orgId),
    countRecords(db, "api_keys", orgId),
    countRecords(db, "subscriptions", orgId),
    countRecords(db, "org_context_chunks", orgId),
  ]);

  return {
    org: org ?? null,
    members,
    invitations,
    workspaceBindings,
    apiKeys,
    subscriptions,
    orgContextChunks,
  };
}

async function deleteOrgR2Objects(
  r2: R2Bucket,
  orgId: string
): Promise<number> {
  const prefix = `orgs/${orgId}/`;
  let deletedCount = 0;
  let cursor: string | undefined;

  do {
    const listResult = await r2.list({ prefix, cursor, limit: 100 });

    if (listResult.objects.length > 0) {
      const keysToDelete = listResult.objects.map((obj) => obj.key);
      await r2.delete(keysToDelete);
      deletedCount += listResult.objects.length;
    }

    cursor = listResult.truncated ? listResult.cursor : undefined;
  } while (cursor);

  return deletedCount;
}

interface DeletedRecordsSummary {
  org: true;
  members: number;
  invitations: number;
  workspaceBindings: number;
  apiKeys: number;
  subscriptions: number;
  orgContextChunks: number;
}

type DeleteOrgResult =
  | {
      success: true;
      deletedRecords: DeletedRecordsSummary;
      deletedR2Objects: number;
      errors: string[];
    }
  | {
      success: false;
      deletedRecords: DeletedRecordsSummary;
      deletedR2Objects: number;
      errors: string[];
    }
  | {
      success: false;
      error: "org_not_found" | "not_owner" | "db_error";
      message: string;
    };

export async function deleteOrg(
  db: D1Database,
  r2: R2Bucket,
  orgId: string,
  requestingUserId: string
): Promise<DeleteOrgResult> {
  // Check org exists
  const orgExists = await db
    .prepare(`SELECT id FROM org WHERE id = ?`)
    .bind(orgId)
    .first();

  if (!orgExists) {
    return {
      success: false,
      error: "org_not_found",
      message: "Organization not found.",
    };
  }

  // Check requester is owner
  const membership = await getOrgMembership(db, requestingUserId, orgId);

  if (!membership?.isOwner) {
    return {
      success: false,
      error: "not_owner",
      message: "Only the owner can delete the organization.",
    };
  }

  // Get preview of what will be deleted (for return value)
  const preview = await getOrgDeletionPreview(db, orgId);
  const errors: string[] = [];

  // Delete org from D1 (cascades to related tables via foreign keys)
  try {
    await db.prepare(`DELETE FROM org WHERE id = ?`).bind(orgId).run();
  } catch (error) {
    return {
      success: false,
      error: "db_error",
      message: `Database error: ${error}`,
    };
  }

  // Delete R2 objects
  let deletedR2Objects = 0;
  try {
    deletedR2Objects = await deleteOrgR2Objects(r2, orgId);
  } catch (error) {
    errors.push(`R2 deletion failed: ${error}`);
  }

  const deletedRecords: DeletedRecordsSummary = {
    org: true,
    members: preview.members,
    invitations: preview.invitations,
    workspaceBindings: preview.workspaceBindings,
    apiKeys: preview.apiKeys,
    subscriptions: preview.subscriptions,
    orgContextChunks: preview.orgContextChunks,
  };

  const hasErrors = errors.length > 0;

  if (hasErrors) {
    return {
      success: false,
      deletedRecords,
      deletedR2Objects,
      errors,
    };
  }

  return {
    success: true,
    deletedRecords,
    deletedR2Objects,
    errors,
  };
}
