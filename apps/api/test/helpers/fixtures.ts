/**
 * Shared test fixtures for database operations.
 * Consolidates duplicated helpers from integration tests.
 */

/**
 * Generates a unique email address for tests.
 */
export function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}@test.com`;
}

/**
 * Creates a test user in the database.
 */
export async function createTestUser(
  db: D1Database,
  options: {
    id?: string;
    email?: string;
    name?: string;
    emailVerified?: boolean;
  } = {}
): Promise<{ id: string; email: string; name: string }> {
  const id = options.id ?? crypto.randomUUID();
  const email = options.email ?? uniqueEmail("user");
  const name = options.name ?? "Test User";
  const now = Date.now();

  await db
    .prepare(
      `INSERT OR IGNORE INTO user (id, name, email, email_verified, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(id, name, email, options.emailVerified !== false ? 1 : 0, now, now)
    .run();

  return { id, email, name };
}

/**
 * Creates a test organization in the database.
 */
export async function createTestOrg(
  db: D1Database,
  options: {
    id?: string;
    name?: string;
    jurisdictions?: string[];
    practiceTypes?: string[];
  } = {}
): Promise<{ id: string; name: string }> {
  const id = options.id ?? crypto.randomUUID();
  const name = options.name ?? "Test Org";
  const now = Date.now();

  await db
    .prepare(
      `INSERT OR IGNORE INTO org (id, name, jurisdictions, practice_types, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      name,
      JSON.stringify(options.jurisdictions ?? []),
      JSON.stringify(options.practiceTypes ?? []),
      now,
      now
    )
    .run();

  return { id, name };
}

/**
 * Adds a user as a member of an organization.
 */
export async function addOrgMember(
  db: D1Database,
  options: {
    orgId: string;
    userId: string;
    role?: "admin" | "member";
    isOwner?: boolean;
  }
): Promise<{ memberId: string }> {
  const memberId = crypto.randomUUID();
  const now = Date.now();
  const role = options.role ?? "member";
  const isOwner = options.isOwner ?? role === "admin";

  await db
    .prepare(
      `INSERT OR IGNORE INTO org_members (id, org_id, user_id, role, is_owner, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(memberId, options.orgId, options.userId, role, isOwner ? 1 : 0, now)
    .run();

  return { memberId };
}

/**
 * Creates an org context chunk with uploaded_by tracking.
 * Used for GDPR deletion tests.
 */
export async function createOrgContextChunk(
  db: D1Database,
  options: {
    id?: string;
    orgId: string;
    content: string;
    uploadedBy: string;
    fileId?: string;
    source?: string;
  }
): Promise<{ id: string }> {
  const id = options.id ?? crypto.randomUUID();

  await db
    .prepare(
      `INSERT INTO org_context_chunks (id, org_id, file_id, content, source, chunk_index, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      options.orgId,
      options.fileId ?? "test-file",
      options.content,
      options.source ?? "test.md",
      0,
      options.uploadedBy
    )
    .run();

  return { id };
}

/**
 * Creates a session for a user.
 */
export async function createSession(
  db: D1Database,
  userId: string,
  options: {
    token?: string;
    expiresInMs?: number;
  } = {}
): Promise<{ sessionId: string; token: string }> {
  const sessionId = crypto.randomUUID();
  const token = options.token ?? crypto.randomUUID();
  const now = Date.now();
  const expiresAt = now + (options.expiresInMs ?? 86400000); // Default 24h

  await db
    .prepare(
      `INSERT INTO session (id, user_id, token, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(sessionId, userId, token, expiresAt, now, now)
    .run();

  return { sessionId, token };
}

/**
 * Creates a channel user link (Teams/Slack).
 */
export async function createChannelLink(
  db: D1Database,
  options: {
    channelType: "teams" | "slack";
    channelUserId: string;
    userId: string;
  }
): Promise<{ id: string }> {
  const id = crypto.randomUUID();
  const now = Date.now();

  await db
    .prepare(
      `INSERT INTO channel_user_links (id, channel_type, channel_user_id, user_id, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(id, options.channelType, options.channelUserId, options.userId, now)
    .run();

  return { id };
}

/**
 * Creates a test account (OAuth provider link).
 */
export async function createAccount(
  db: D1Database,
  options: {
    userId: string;
    providerId: string;
    accountId?: string;
  }
): Promise<{ id: string }> {
  const id = crypto.randomUUID();
  const accountId = options.accountId ?? crypto.randomUUID();
  const now = Date.now();

  await db
    .prepare(
      `INSERT INTO account (id, user_id, account_id, provider_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(id, options.userId, accountId, options.providerId, now, now)
    .run();

  return { id };
}
