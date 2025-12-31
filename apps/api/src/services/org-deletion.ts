import { getOrgMembership } from "./org-membership";

export interface OrgDeletionPreview {
  org: { id: string; name: string } | null;
  members: number;
  invitations: number;
  workspaceBindings: number;
  apiKeys: number;
  subscriptions: number;
  orgContextChunks: number;
}

interface DODeletionResult {
  conversations: number;
  messages: number;
  pendingConfirmations: number;
  kvEntries: number;
}

interface DeletedRecords {
  org: true;
  members: number;
  invitations: number;
  workspaceBindings: number;
  apiKeys: number;
  subscriptions: number;
  orgContextChunks: number;
}

type DeleteOrgSuccess = {
  success: true;
  deletedRecords: DeletedRecords;
  deletedR2Objects: number;
  deletedDO: DODeletionResult | null;
  errors: string[];
};

type DeleteOrgPartialSuccess = {
  success: false;
  deletedRecords: DeletedRecords;
  deletedR2Objects: number;
  deletedDO: DODeletionResult | null;
  errors: string[];
};

type DeleteOrgError = {
  success: false;
  error: "org_not_found" | "not_owner" | "db_error";
  message: string;
};

type DeleteOrgResult =
  | DeleteOrgSuccess
  | DeleteOrgPartialSuccess
  | DeleteOrgError;

const ALLOWED_TABLES = new Set([
  "org_members",
  "invitations",
  "workspace_bindings",
  "api_keys",
  "subscriptions",
  "org_context_chunks",
]);

async function countRecords(
  db: D1Database,
  table: string,
  orgId: string
): Promise<number> {
  if (!ALLOWED_TABLES.has(table)) {
    throw new Error(`Invalid table name: ${table}`);
  }
  const result = await db
    .prepare(`SELECT COUNT(*) as count FROM ${table} WHERE org_id = ?`)
    .bind(orgId)
    .first<{ count: number }>();
  return result?.count ?? 0;
}

/**
 * Returns a preview of what will be deleted when an org is deleted.
 * Useful for showing the user before they confirm deletion.
 */
export async function getOrgDeletionPreview(
  db: D1Database,
  orgId: string
): Promise<OrgDeletionPreview> {
  // Fetch org info and all record counts in parallel
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

/**
 * Deletes an organization and all associated data.
 *
 * Deletion order:
 * 1. Verify the org exists and the user is the owner
 * 2. Delete the org from D1 (cascades to related tables)
 * 3. Delete R2 objects (documents, audit logs)
 * 4. Delete Durable Object data (conversations, messages, tokens)
 *
 * Returns partial success if D1 deletion succeeds but R2/DO cleanup fails.
 */
export async function deleteOrg(
  db: D1Database,
  r2: R2Bucket,
  orgId: string,
  requestingUserId: string,
  tenant?: DurableObjectNamespace
): Promise<DeleteOrgResult> {
  // Verify org exists
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

  // Verify user is the owner
  const membership = await getOrgMembership(db, requestingUserId, orgId);
  if (!membership?.isOwner) {
    return {
      success: false,
      error: "not_owner",
      message: "Only the owner can delete the organization.",
    };
  }

  // Get record counts before deletion (for the response)
  const preview = await getOrgDeletionPreview(db, orgId);

  // Delete the org from D1 (foreign keys will cascade)
  try {
    await db.prepare(`DELETE FROM org WHERE id = ?`).bind(orgId).run();
  } catch (error) {
    return {
      success: false,
      error: "db_error",
      message: `Database error: ${error}`,
    };
  }

  // Track non-fatal errors for partial success reporting
  const errors: string[] = [];

  // Delete R2 objects
  const deletedR2Objects = await deleteR2Objects(r2, orgId, errors);

  // Delete Durable Object data
  const deletedDO = await deleteDurableObjectData(tenant, orgId, errors);

  // Build the response
  const deletedRecords: DeletedRecords = {
    org: true,
    members: preview.members,
    invitations: preview.invitations,
    workspaceBindings: preview.workspaceBindings,
    apiKeys: preview.apiKeys,
    subscriptions: preview.subscriptions,
    orgContextChunks: preview.orgContextChunks,
  };

  if (errors.length === 0) {
    return {
      success: true,
      deletedRecords,
      deletedR2Objects,
      deletedDO,
      errors,
    };
  }

  return {
    success: false,
    deletedRecords,
    deletedR2Objects,
    deletedDO,
    errors,
  };
}

/**
 * Deletes all R2 objects for an org.
 * Uses pagination to handle large numbers of objects.
 */
async function deleteR2Objects(
  r2: R2Bucket,
  orgId: string,
  errors: string[]
): Promise<number> {
  let deletedCount = 0;

  try {
    let cursor: string | undefined;

    do {
      const list = await r2.list({
        prefix: `orgs/${orgId}/`,
        cursor,
        limit: 100,
      });

      if (list.objects.length > 0) {
        const keys = list.objects.map((obj) => obj.key);
        await r2.delete(keys);
        deletedCount += list.objects.length;
      }

      cursor = list.truncated ? list.cursor : undefined;
    } while (cursor);
  } catch (error) {
    errors.push(`R2 deletion failed: ${error}`);
  }

  return deletedCount;
}

/**
 * Tells the Durable Object to delete all its data for this org.
 */
async function deleteDurableObjectData(
  tenant: DurableObjectNamespace | undefined,
  orgId: string,
  errors: string[]
): Promise<DODeletionResult | null> {
  if (!tenant) {
    return null;
  }

  try {
    const stub = tenant.get(tenant.idFromName(orgId));
    const request = new Request("https://do/delete-org", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    const response = await stub.fetch(request);

    if (!response.ok) {
      errors.push(`DO deletion failed: ${response.status}`);
      return null;
    }

    const body = (await response.json()) as { deleted: DODeletionResult };
    return body.deleted;
  } catch (error) {
    errors.push(`DO deletion failed: ${error}`);
    return null;
  }
}
