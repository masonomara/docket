import { getOrgMembership } from "./org-membership";

export interface OrgDeletionResult {
  success: boolean;
  deletedRecords: {
    org: boolean;
    members: number;
    invitations: number;
    workspaceBindings: number;
    apiKeys: number;
    subscriptions: number;
    orgContextChunks: number;
  };
  deletedR2Objects: number;
  errors: string[];
}

export interface OrgDeletionError {
  success: false;
  error: "org_not_found" | "not_owner" | "db_error";
  message: string;
}

/**
 * Counts records that will be deleted when org is removed.
 * Useful for showing user before they confirm deletion.
 */
export async function getOrgDeletionPreview(
  db: D1Database,
  orgId: string
): Promise<{
  org: { id: string; name: string } | null;
  members: number;
  invitations: number;
  workspaceBindings: number;
  apiKeys: number;
  subscriptions: number;
  orgContextChunks: number;
}> {
  const [
    org,
    members,
    invitations,
    workspaceBindings,
    apiKeys,
    subscriptions,
    orgContextChunks,
  ] = await Promise.all([
    db
      .prepare(`SELECT id, name FROM org WHERE id = ?`)
      .bind(orgId)
      .first<{ id: string; name: string }>(),
    db
      .prepare(`SELECT COUNT(*) as count FROM org_members WHERE org_id = ?`)
      .bind(orgId)
      .first<{ count: number }>(),
    db
      .prepare(`SELECT COUNT(*) as count FROM invitations WHERE org_id = ?`)
      .bind(orgId)
      .first<{ count: number }>(),
    db
      .prepare(
        `SELECT COUNT(*) as count FROM workspace_bindings WHERE org_id = ?`
      )
      .bind(orgId)
      .first<{ count: number }>(),
    db
      .prepare(`SELECT COUNT(*) as count FROM api_keys WHERE org_id = ?`)
      .bind(orgId)
      .first<{ count: number }>(),
    db
      .prepare(`SELECT COUNT(*) as count FROM subscriptions WHERE org_id = ?`)
      .bind(orgId)
      .first<{ count: number }>(),
    db
      .prepare(
        `SELECT COUNT(*) as count FROM org_context_chunks WHERE org_id = ?`
      )
      .bind(orgId)
      .first<{ count: number }>(),
  ]);

  return {
    org: org ?? null,
    members: members?.count ?? 0,
    invitations: invitations?.count ?? 0,
    workspaceBindings: workspaceBindings?.count ?? 0,
    apiKeys: apiKeys?.count ?? 0,
    subscriptions: subscriptions?.count ?? 0,
    orgContextChunks: orgContextChunks?.count ?? 0,
  };
}

/**
 * Deletes all R2 objects under orgs/{orgId}/
 * Returns count of deleted objects.
 */
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
      const keys = listResult.objects.map((obj) => obj.key);
      await r2.delete(keys);
      deletedCount += keys.length;
    }

    cursor = listResult.truncated ? listResult.cursor : undefined;
  } while (cursor);

  return deletedCount;
}

/**
 * Deletes an organization and all associated data.
 * Only the owner can delete the org.
 *
 * D1 cleanup (cascades automatically):
 * - org_members, invitations, workspace_bindings, api_keys, subscriptions, org_context_chunks
 *
 * R2 cleanup:
 * - /orgs/{org_id}/docs/
 * - /orgs/{org_id}/audit/
 * - /orgs/{org_id}/conversations/
 *
 * TODO Phase 6: Delete DO instance (SQLite + Storage)
 * TODO Phase 5: Delete Vectorize embeddings with org_id metadata
 */
export async function deleteOrg(
  db: D1Database,
  r2: R2Bucket,
  orgId: string,
  requestingUserId: string
): Promise<OrgDeletionResult | OrgDeletionError> {
  // Verify org exists
  const org = await db
    .prepare(`SELECT id FROM org WHERE id = ?`)
    .bind(orgId)
    .first<{ id: string }>();

  if (!org) {
    return {
      success: false,
      error: "org_not_found",
      message: "Organization not found.",
    };
  }

  // Verify requesting user is owner
  const membership = await getOrgMembership(db, requestingUserId, orgId);

  if (!membership || !membership.isOwner) {
    return {
      success: false,
      error: "not_owner",
      message: "Only the owner can delete the organization.",
    };
  }

  // Get counts before deletion
  const preview = await getOrgDeletionPreview(db, orgId);
  const errors: string[] = [];

  // Delete from D1 (cascades to related tables)
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

  return {
    success: errors.length === 0,
    deletedRecords: {
      org: true,
      members: preview.members,
      invitations: preview.invitations,
      workspaceBindings: preview.workspaceBindings,
      apiKeys: preview.apiKeys,
      subscriptions: preview.subscriptions,
      orgContextChunks: preview.orgContextChunks,
    },
    deletedR2Objects,
    errors,
  };
}
