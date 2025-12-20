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

export function hashUserId(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash << 5) - hash + userId.charCodeAt(i);
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16).padStart(8, "0");
}

export async function checkSoleOwnerships(
  db: D1Database,
  userId: string
): Promise<string[]> {
  const ownerships = await db
    .prepare(
      `SELECT org_id FROM org_members WHERE user_id = ? AND is_owner = 1`
    )
    .bind(userId)
    .all<{ org_id: string }>();
  const soleOwnerOrgs: string[] = [];

  for (const { org_id } of ownerships.results) {
    const otherOwners = await db
      .prepare(
        `SELECT COUNT(*) as count FROM org_members WHERE org_id = ? AND is_owner = 1 AND user_id != ?`
      )
      .bind(org_id, userId)
      .first<{ count: number }>();
    if (otherOwners?.count === 0) soleOwnerOrgs.push(org_id);
  }

  return soleOwnerOrgs;
}

export async function anonymizeAuditLogs(
  r2: R2Bucket,
  userId: string
): Promise<number> {
  const hashedId = `REDACTED-${hashUserId(userId)}`;
  let count = 0;
  let cursor: string | undefined;

  do {
    const list = await r2.list({ prefix: "orgs/", cursor, limit: 100 });
    for (const obj of list.objects) {
      if (!obj.key.includes("/audit/")) continue;
      const content = await r2.get(obj.key);
      if (!content) continue;
      try {
        const entry = (await content.json()) as { user_id?: string };
        if (entry.user_id === userId) {
          entry.user_id = hashedId;
          await r2.put(obj.key, JSON.stringify(entry), {
            httpMetadata: { contentType: "application/json" },
          });
          count++;
        }
      } catch {}
    }
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);

  return count;
}

async function deleteUserFromD1(
  db: D1Database,
  userId: string
): Promise<{
  sessions: number;
  accounts: number;
  channelLinks: number;
  orgMemberships: number;
}> {
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

  await db.prepare(`DELETE FROM user WHERE id = ?`).bind(userId).run();

  return {
    sessions: sessions?.count ?? 0,
    accounts: accounts?.count ?? 0,
    channelLinks: channelLinks?.count ?? 0,
    orgMemberships: orgMemberships?.count ?? 0,
  };
}

export async function deleteUserData(
  db: D1Database,
  r2: R2Bucket,
  userId: string
): Promise<GdprDeleteResult | SoleOwnershipError> {
  const errors: string[] = [];
  const soleOwnerOrgs = await checkSoleOwnerships(db, userId);

  if (soleOwnerOrgs.length > 0) {
    return {
      type: "sole_owner",
      orgIds: soleOwnerOrgs,
      message: `User is sole owner of ${soleOwnerOrgs.length} organization(s). Transfer ownership first.`,
    };
  }

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

  let deletedRecords;
  try {
    deletedRecords = await deleteUserFromD1(db, userId);
  } catch (e) {
    errors.push(`D1 deletion failed: ${e}`);
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
      errors,
    };
  }

  let anonymizedCount = 0;
  try {
    anonymizedCount = await anonymizeAuditLogs(r2, userId);
  } catch (e) {
    errors.push(`Audit log anonymization failed: ${e}`);
  }

  return {
    success: errors.length === 0,
    deletedRecords: { user: true, ...deletedRecords },
    anonymizedAuditLogs: anonymizedCount,
    errors,
  };
}

export async function getDataDeletionPreview(
  db: D1Database,
  userId: string
): Promise<{
  user: { email: string; name: string } | null;
  sessions: number;
  accounts: number;
  channelLinks: number;
  orgMemberships: number;
  soleOwnerOrgs: string[];
}> {
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

  return {
    user: user ?? null,
    sessions: sessions?.count ?? 0,
    accounts: accounts?.count ?? 0,
    channelLinks: channelLinks?.count ?? 0,
    orgMemberships: orgMemberships?.count ?? 0,
    soleOwnerOrgs: await checkSoleOwnerships(db, userId),
  };
}
