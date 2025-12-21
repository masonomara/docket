import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { deleteOrg, getOrgDeletionPreview } from "../../src/services/org-deletion";

// Test data constants
const TEST_ORG_ID = "test-org-deletion";
const OWNER_USER_ID = "del-owner";
const MEMBER_USER_ID = "del-member";
const NON_MEMBER_USER_ID = "del-nonmember";

async function insertTestUser(userId: string, timestamp: number) {
  const query = `
    INSERT OR IGNORE INTO user (id, email, name, email_verified, created_at, updated_at)
    VALUES (?, ?, ?, 0, ?, ?)
  `;
  await env.DB.prepare(query)
    .bind(userId, `${userId}@test.com`, userId, timestamp, timestamp)
    .run();
}

async function insertTestMember(
  memberId: string,
  userId: string,
  orgId: string,
  role: string,
  isOwner: number,
  timestamp: number
) {
  const query = `
    INSERT OR IGNORE INTO org_members (id, user_id, org_id, role, is_owner, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `;
  await env.DB.prepare(query)
    .bind(memberId, userId, orgId, role, isOwner, timestamp)
    .run();
}

beforeAll(async () => {
  const now = Date.now();

  // Create test org
  await env.DB.prepare("INSERT OR IGNORE INTO org (id, name) VALUES (?, ?)")
    .bind(TEST_ORG_ID, "Test Org for Deletion")
    .run();

  // Create test users
  await Promise.all([
    insertTestUser(OWNER_USER_ID, now),
    insertTestUser(MEMBER_USER_ID, now),
    insertTestUser(NON_MEMBER_USER_ID, now),
  ]);

  // Add members to org
  await Promise.all([
    insertTestMember(
      "om-del-owner",
      OWNER_USER_ID,
      TEST_ORG_ID,
      "admin",
      1,
      now
    ),
    insertTestMember(
      "om-del-member",
      MEMBER_USER_ID,
      TEST_ORG_ID,
      "member",
      0,
      now
    ),
  ]);

  // Add test invitation
  const invitationQuery = `
    INSERT OR IGNORE INTO invitations (id, email, org_id, role, invited_by, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `;
  await env.DB.prepare(invitationQuery)
    .bind(
      "inv-del-1",
      "x@t.com",
      TEST_ORG_ID,
      "member",
      OWNER_USER_ID,
      now,
      now + 86400000
    )
    .run();

  // Add test workspace binding
  const workspaceQuery = `
    INSERT OR IGNORE INTO workspace_bindings (id, channel_type, workspace_id, org_id, created_at)
    VALUES (?, ?, ?, ?, ?)
  `;
  await env.DB.prepare(workspaceQuery)
    .bind("wb-del-1", "teams", "ws-123", TEST_ORG_ID, now)
    .run();

  // Add test API key
  const apiKeyQuery = `
    INSERT OR IGNORE INTO api_keys (id, org_id, user_id, key_hash, key_prefix, name, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `;
  await env.DB.prepare(apiKeyQuery)
    .bind("ak-del-1", TEST_ORG_ID, OWNER_USER_ID, "h", "dk_", "K", now)
    .run();

  // Add test R2 objects
  await Promise.all([
    env.R2.put(`orgs/${TEST_ORG_ID}/docs/f1.pdf`, "x"),
    env.R2.put(`orgs/${TEST_ORG_ID}/docs/f2.docx`, "x"),
    env.R2.put(`orgs/${TEST_ORG_ID}/audit/2025/01/15/e1.json`, "{}"),
    env.R2.put(`orgs/${TEST_ORG_ID}/conv/c1.json`, "{}"),
  ]);
});

describe("getOrgDeletionPreview", () => {
  it("returns correct counts for existing org", async () => {
    const preview = await getOrgDeletionPreview(env.DB, TEST_ORG_ID);

    expect(preview.org?.name).toBe("Test Org for Deletion");
    expect(preview.members).toBe(2);
    expect(preview.invitations).toBe(1);
    expect(preview.workspaceBindings).toBe(1);
    expect(preview.apiKeys).toBe(1);
  });

  it("returns null org for nonexistent org", async () => {
    const preview = await getOrgDeletionPreview(env.DB, "nonexistent");

    expect(preview.org).toBeNull();
    expect(preview.members).toBe(0);
  });
});

describe("deleteOrg", () => {
  it("errors for nonexistent org", async () => {
    const result = await deleteOrg(
      env.DB,
      env.R2,
      "nonexistent",
      OWNER_USER_ID
    );

    expect(result.success).toBe(false);
    if ("error" in result) {
      expect(result.error).toBe("org_not_found");
    }
  });

  it("blocks non-owner from deleting", async () => {
    // Create a temporary org for this test
    const testOrgId = `block-${Date.now()}`;
    const ownerId = `owner-${Date.now()}`;
    const memberId = `member-${Date.now()}`;
    const now = Date.now();

    await env.DB.prepare("INSERT INTO org (id, name) VALUES (?, ?)")
      .bind(testOrgId, "Block Test Org")
      .run();

    await Promise.all([
      insertTestUser(ownerId, now),
      insertTestUser(memberId, now),
    ]);

    await Promise.all([
      insertTestMember(`om-${ownerId}`, ownerId, testOrgId, "admin", 1, now),
      insertTestMember(`om-${memberId}`, memberId, testOrgId, "member", 0, now),
    ]);

    const result = await deleteOrg(env.DB, env.R2, testOrgId, memberId);

    expect(result.success).toBe(false);
    if ("error" in result) {
      expect(result.error).toBe("not_owner");
    }
  });

  it("blocks non-member from deleting", async () => {
    const result = await deleteOrg(
      env.DB,
      env.R2,
      TEST_ORG_ID,
      NON_MEMBER_USER_ID
    );

    expect(result.success).toBe(false);
    if ("error" in result) {
      expect(result.error).toBe("not_owner");
    }
  });

  it("successfully deletes org and all related data", async () => {
    // Create a fresh org for this test
    const testOrgId = `del-${Date.now()}`;
    const ownerId = `owner-${Date.now()}`;
    const memberId = `member-${Date.now()}`;
    const now = Date.now();

    await env.DB.prepare("INSERT INTO org (id, name) VALUES (?, ?)")
      .bind(testOrgId, "Delete Test Org")
      .run();

    await Promise.all([
      insertTestUser(ownerId, now),
      insertTestUser(memberId, now),
    ]);

    await Promise.all([
      insertTestMember(`om-${ownerId}`, ownerId, testOrgId, "admin", 1, now),
      insertTestMember(`om-${memberId}`, memberId, testOrgId, "member", 0, now),
    ]);

    // Add an invitation
    await env.DB.prepare(
      `INSERT INTO invitations (id, email, org_id, role, invited_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        `inv-${testOrgId}`,
        "x@t.com",
        testOrgId,
        "member",
        ownerId,
        now,
        now + 86400000
      )
      .run();

    // Add R2 objects
    await Promise.all([
      env.R2.put(`orgs/${testOrgId}/docs/t.pdf`, "x"),
      env.R2.put(`orgs/${testOrgId}/audit/e.json`, "{}"),
    ]);

    // Execute deletion
    const result = await deleteOrg(env.DB, env.R2, testOrgId, ownerId);

    expect(result.success).toBe(true);

    if ("deletedRecords" in result) {
      expect(result.deletedRecords.org).toBe(true);
      expect(result.deletedRecords.members).toBe(2);
      expect(result.deletedR2Objects).toBe(2);
    }

    // Verify org is gone from database
    const orgCheck = await env.DB.prepare("SELECT id FROM org WHERE id = ?")
      .bind(testOrgId)
      .first();
    expect(orgCheck).toBeNull();

    // Verify R2 objects are gone
    const r2Objects = await env.R2.list({ prefix: `orgs/${testOrgId}/` });
    expect(r2Objects.objects.length).toBe(0);
  });

  it("handles R2 pagination correctly", async () => {
    // Create org with many R2 objects
    const testOrgId = `pag-${Date.now()}`;
    const ownerId = `owner-${Date.now()}`;
    const now = Date.now();

    await env.DB.prepare("INSERT INTO org (id, name) VALUES (?, ?)")
      .bind(testOrgId, "Pagination Test Org")
      .run();

    await insertTestUser(ownerId, now);
    await insertTestMember(
      `om-${ownerId}`,
      ownerId,
      testOrgId,
      "admin",
      1,
      now
    );

    // Create 5 R2 objects
    for (let i = 0; i < 5; i++) {
      await env.R2.put(`orgs/${testOrgId}/docs/f${i}.txt`, "x");
    }

    // Verify objects exist
    const beforeDeletion = await env.R2.list({ prefix: `orgs/${testOrgId}/` });
    expect(beforeDeletion.objects.length).toBe(5);

    // Execute deletion
    const result = await deleteOrg(env.DB, env.R2, testOrgId, ownerId);

    expect(result.success).toBe(true);

    if ("deletedR2Objects" in result) {
      expect(result.deletedR2Objects).toBe(5);
    }

    // Verify all R2 objects are gone
    const afterDeletion = await env.R2.list({ prefix: `orgs/${testOrgId}/` });
    expect(afterDeletion.objects.length).toBe(0);
  });
});
