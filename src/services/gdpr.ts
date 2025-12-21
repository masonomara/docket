export interface GdprDeleteResult {
  success: boolean;
  deletedRecords: {
    user: boolean;
    sessions: number;
    accounts: number;
    channelLinks: number;
    orgMemberships: number;
  };
  anonymizedAuditLogs: number;
  errors: string[];
}

export interface SoleOwnershipError {
  type: "sole_owner";
  orgIds: string[];
  message: string;
}

/**
 * Creates a cryptographic hash of a user ID for anonymization.
 * Uses SHA-256 for GDPR-compliant irreversible anonymization.
 */
export async function hashUserId(userId: string): Promise<string> {
  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(userId)
  );
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .substring(0, 16);
}

/**
 * Checks if a user is the sole owner of any organizations.
 * Returns list of org IDs where user is the only owner.
 */
export async function checkSoleOwnerships(
  db: D1Database,
  userId: string
): Promise<string[]> {
  // Find all orgs where this user is an owner
  const ownerships = await db
    .prepare(
      `SELECT org_id FROM org_members WHERE user_id = ? AND is_owner = 1`
    )
    .bind(userId)
    .all<{ org_id: string }>();

  const soleOwnerOrgs: string[] = [];

  // Check each org for other owners
  for (const { org_id: orgId } of ownerships.results) {
    const otherOwners = await db
      .prepare(
        `SELECT COUNT(*) as count
         FROM org_members
         WHERE org_id = ? AND is_owner = 1 AND user_id != ?`
      )
      .bind(orgId, userId)
      .first<{ count: number }>();

    if (otherOwners?.count === 0) {
      soleOwnerOrgs.push(orgId);
    }
  }

  return soleOwnerOrgs;
}

/**
 * Anonymizes audit logs in R2 by replacing user_id with a hashed version.
 * Returns the count of anonymized entries.
 */
export async function anonymizeAuditLogs(
  r2: R2Bucket,
  userId: string
): Promise<number> {
  const hashedId = `REDACTED-${await hashUserId(userId)}`;
  let count = 0;
  let cursor: string | undefined;

  do {
    const listResult = await r2.list({
      prefix: "orgs/",
      cursor,
      limit: 100,
    });

    for (const obj of listResult.objects) {
      // Only process audit log entries
      if (!obj.key.includes("/audit/")) {
        continue;
      }

      const content = await r2.get(obj.key);
      if (!content) {
        continue;
      }

      try {
        const entry = (await content.json()) as { user_id?: string };

        if (entry.user_id === userId) {
          entry.user_id = hashedId;

          await r2.put(obj.key, JSON.stringify(entry), {
            httpMetadata: { contentType: "application/json" },
          });

          count++;
        }
      } catch {
        // Skip entries that can't be parsed
      }
    }

    cursor = listResult.truncated ? listResult.cursor : undefined;
  } while (cursor);

  return count;
}

/**
 * Counts and deletes all user-related records from D1.
 * Returns counts of deleted records by type.
 */
async function deleteUserFromD1(db: D1Database, userId: string) {
  // First, count all related records
  const [sessions, accounts, channelLinks, orgMemberships] = await Promise.all([
    db
      .prepare(`SELECT COUNT(*) as count FROM session WHERE user_id = ?`)
      .bind(userId)
      .first<{ count: number }>(),
    db
      .prepare(`SELECT COUNT(*) as count FROM account WHERE user_id = ?`)
      .bind(userId)
      .first<{ count: number }>(),
    db
      .prepare(
        `SELECT COUNT(*) as count FROM channel_user_links WHERE user_id = ?`
      )
      .bind(userId)
      .first<{ count: number }>(),
    db
      .prepare(`SELECT COUNT(*) as count FROM org_members WHERE user_id = ?`)
      .bind(userId)
      .first<{ count: number }>(),
  ]);

  // Delete user (cascades to related tables)
  await db.prepare(`DELETE FROM user WHERE id = ?`).bind(userId).run();

  return {
    sessions: sessions?.count ?? 0,
    accounts: accounts?.count ?? 0,
    channelLinks: channelLinks?.count ?? 0,
    orgMemberships: orgMemberships?.count ?? 0,
  };
}

/**
 * Deletes all user data for GDPR compliance.
 * Fails if user is sole owner of any organization.
 */
export async function deleteUserData(
  db: D1Database,
  r2: R2Bucket,
  userId: string
): Promise<GdprDeleteResult | SoleOwnershipError> {
  // Check for sole ownership - must transfer ownership first
  const soleOwnerOrgs = await checkSoleOwnerships(db, userId);

  if (soleOwnerOrgs.length > 0) {
    return {
      type: "sole_owner",
      orgIds: soleOwnerOrgs,
      message: `User is sole owner of ${soleOwnerOrgs.length} organization(s). Transfer ownership first.`,
    };
  }

  // Verify user exists
  const user = await db
    .prepare(`SELECT id FROM user WHERE id = ?`)
    .bind(userId)
    .first<{ id: string }>();

  if (!user) {
    return {
      success: false,
      deletedRecords: {
        user: false,
        sessions: 0,
        accounts: 0,
        channelLinks: 0,
        orgMemberships: 0,
      },
      anonymizedAuditLogs: 0,
      errors: ["User not found"],
    };
  }

  const errors: string[] = [];

  // Delete from D1
  let deletedRecords;
  try {
    deletedRecords = await deleteUserFromD1(db, userId);
  } catch (error) {
    return {
      success: false,
      deletedRecords: {
        user: false,
        sessions: 0,
        accounts: 0,
        channelLinks: 0,
        orgMemberships: 0,
      },
      anonymizedAuditLogs: 0,
      errors: [`D1 deletion failed: ${error}`],
    };
  }

  // Anonymize audit logs
  let anonymizedCount = 0;
  try {
    anonymizedCount = await anonymizeAuditLogs(r2, userId);
  } catch (error) {
    errors.push(`Audit log anonymization failed: ${error}`);
  }

  return {
    success: errors.length === 0,
    deletedRecords: {
      user: true,
      ...deletedRecords,
    },
    anonymizedAuditLogs: anonymizedCount,
    errors,
  };
}

/**
 * Gets a preview of what data would be deleted for a user.
 * Useful for showing users before they confirm deletion.
 */
export async function getDataDeletionPreview(db: D1Database, userId: string) {
  const [user, sessions, accounts, channelLinks, orgMemberships] =
    await Promise.all([
      db
        .prepare(`SELECT email, name FROM user WHERE id = ?`)
        .bind(userId)
        .first<{ email: string; name: string }>(),
      db
        .prepare(`SELECT COUNT(*) as count FROM session WHERE user_id = ?`)
        .bind(userId)
        .first<{ count: number }>(),
      db
        .prepare(`SELECT COUNT(*) as count FROM account WHERE user_id = ?`)
        .bind(userId)
        .first<{ count: number }>(),
      db
        .prepare(
          `SELECT COUNT(*) as count FROM channel_user_links WHERE user_id = ?`
        )
        .bind(userId)
        .first<{ count: number }>(),
      db
        .prepare(`SELECT COUNT(*) as count FROM org_members WHERE user_id = ?`)
        .bind(userId)
        .first<{ count: number }>(),
    ]);

  const soleOwnerOrgs = await checkSoleOwnerships(db, userId);

  return {
    user: user ?? null,
    sessions: sessions?.count ?? 0,
    accounts: accounts?.count ?? 0,
    channelLinks: channelLinks?.count ?? 0,
    orgMemberships: orgMemberships?.count ?? 0,
    soleOwnerOrgs,
  };
}
