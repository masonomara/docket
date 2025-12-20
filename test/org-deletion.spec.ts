import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { deleteOrg, getOrgDeletionPreview } from "../src/services/org-deletion";

// ============================================================================
// Test Setup
// ============================================================================

const TEST_ORG_ID = "test-org-deletion";
const OWNER_ID = "deletion-owner";
const MEMBER_ID = "deletion-member";
const NON_MEMBER_ID = "deletion-nonmember";

beforeAll(async () => {
  const now = Date.now();

  // Create test org
  await env.DB.prepare("INSERT OR IGNORE INTO org (id, name) VALUES (?, ?)")
    .bind(TEST_ORG_ID, "Test Org for Deletion")
    .run();

  // Create test users
  const users = [
    { id: OWNER_ID, email: "deletion-owner@test.com", name: "Owner" },
    { id: MEMBER_ID, email: "deletion-member@test.com", name: "Member" },
    {
      id: NON_MEMBER_ID,
      email: "deletion-nonmember@test.com",
      name: "Non Member",
    },
  ];

  for (const user of users) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO user (id, email, name, email_verified, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?)`
    )
      .bind(user.id, user.email, user.name, now, now)
      .run();
  }

  // Create org memberships
  await env.DB.prepare(
    `INSERT OR IGNORE INTO org_members (id, user_id, org_id, role, is_owner, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind("om-del-owner", OWNER_ID, TEST_ORG_ID, "admin", 1, now)
    .run();

  await env.DB.prepare(
    `INSERT OR IGNORE INTO org_members (id, user_id, org_id, role, is_owner, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind("om-del-member", MEMBER_ID, TEST_ORG_ID, "member", 0, now)
    .run();

  // Create an invitation
  await env.DB.prepare(
    `INSERT OR IGNORE INTO invitations (id, email, org_id, role, invited_by, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      "inv-del-1",
      "invited@test.com",
      TEST_ORG_ID,
      "member",
      OWNER_ID,
      now,
      now + 86400000
    )
    .run();

  // Create a workspace binding
  await env.DB.prepare(
    `INSERT OR IGNORE INTO workspace_bindings (id, channel_type, workspace_id, org_id, created_at)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind("wb-del-1", "teams", "teams-workspace-123", TEST_ORG_ID, now)
    .run();

  // Create an API key
  await env.DB.prepare(
    `INSERT OR IGNORE INTO api_keys (id, org_id, user_id, key_hash, key_prefix, name, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind("ak-del-1", TEST_ORG_ID, OWNER_ID, "hash123", "dk_", "Test Key", now)
    .run();

  // Create some R2 objects
  await env.R2.put(`orgs/${TEST_ORG_ID}/docs/file1.pdf`, "pdf content");
  await env.R2.put(`orgs/${TEST_ORG_ID}/docs/file2.docx`, "docx content");
  await env.R2.put(
    `orgs/${TEST_ORG_ID}/audit/2025/01/15/entry1.json`,
    '{"action":"test"}'
  );
  await env.R2.put(
    `orgs/${TEST_ORG_ID}/conversations/conv1.json`,
    '{"messages":[]}'
  );
});

// ============================================================================
// getOrgDeletionPreview Tests
// ============================================================================

describe("getOrgDeletionPreview", () => {
  it("returns counts of all related records", async () => {
    const preview = await getOrgDeletionPreview(env.DB, TEST_ORG_ID);

    expect(preview.org).not.toBeNull();
    expect(preview.org?.name).toBe("Test Org for Deletion");
    expect(preview.members).toBe(2); // owner + member
    expect(preview.invitations).toBe(1);
    expect(preview.workspaceBindings).toBe(1);
    expect(preview.apiKeys).toBe(1);
  });

  it("returns null org for non-existent org", async () => {
    const preview = await getOrgDeletionPreview(env.DB, "nonexistent-org");

    expect(preview.org).toBeNull();
    expect(preview.members).toBe(0);
  });
});

// ============================================================================
// deleteOrg Tests
// ============================================================================

describe("deleteOrg", () => {
  it("returns error for non-existent org", async () => {
    const result = await deleteOrg(env.DB, env.R2, "nonexistent-org", OWNER_ID);

    expect(result.success).toBe(false);
    expect("error" in result && result.error).toBe("org_not_found");
  });

  it("blocks non-owner from deleting", async () => {
    // Create a fresh org for this test
    const orgId = `delete-block-${Date.now()}`;
    const ownerId = `block-owner-${Date.now()}`;
    const memberId = `block-member-${Date.now()}`;
    const now = Date.now();

    await env.DB.prepare("INSERT INTO org (id, name) VALUES (?, ?)")
      .bind(orgId, "Block Test Org")
      .run();

    await env.DB.prepare(
      `INSERT INTO user (id, email, name, email_verified, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?)`
    )
      .bind(ownerId, `${ownerId}@test.com`, "Owner", now, now)
      .run();

    await env.DB.prepare(
      `INSERT INTO user (id, email, name, email_verified, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?)`
    )
      .bind(memberId, `${memberId}@test.com`, "Member", now, now)
      .run();

    await env.DB.prepare(
      `INSERT INTO org_members (id, user_id, org_id, role, is_owner, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(`om-${ownerId}`, ownerId, orgId, "admin", 1, now)
      .run();

    await env.DB.prepare(
      `INSERT INTO org_members (id, user_id, org_id, role, is_owner, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(`om-${memberId}`, memberId, orgId, "member", 0, now)
      .run();

    // Try to delete as member
    const result = await deleteOrg(env.DB, env.R2, orgId, memberId);

    expect(result.success).toBe(false);
    expect("error" in result && result.error).toBe("not_owner");

    // Verify org still exists
    const org = await env.DB.prepare("SELECT id FROM org WHERE id = ?")
      .bind(orgId)
      .first();
    expect(org).not.toBeNull();
  });

  it("blocks non-member from deleting", async () => {
    const result = await deleteOrg(env.DB, env.R2, TEST_ORG_ID, NON_MEMBER_ID);

    expect(result.success).toBe(false);
    expect("error" in result && result.error).toBe("not_owner");
  });

  it("successfully deletes org and all related data", async () => {
    // Create a fresh org for this test
    const orgId = `delete-success-${Date.now()}`;
    const ownerId = `success-owner-${Date.now()}`;
    const memberId = `success-member-${Date.now()}`;
    const now = Date.now();

    // Create org
    await env.DB.prepare("INSERT INTO org (id, name) VALUES (?, ?)")
      .bind(orgId, "Success Test Org")
      .run();

    // Create users
    await env.DB.prepare(
      `INSERT INTO user (id, email, name, email_verified, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?)`
    )
      .bind(ownerId, `${ownerId}@test.com`, "Owner", now, now)
      .run();

    await env.DB.prepare(
      `INSERT INTO user (id, email, name, email_verified, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?)`
    )
      .bind(memberId, `${memberId}@test.com`, "Member", now, now)
      .run();

    // Create memberships
    await env.DB.prepare(
      `INSERT INTO org_members (id, user_id, org_id, role, is_owner, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(`om-${ownerId}`, ownerId, orgId, "admin", 1, now)
      .run();

    await env.DB.prepare(
      `INSERT INTO org_members (id, user_id, org_id, role, is_owner, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(`om-${memberId}`, memberId, orgId, "member", 0, now)
      .run();

    // Create invitation
    await env.DB.prepare(
      `INSERT INTO invitations (id, email, org_id, role, invited_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        `inv-${orgId}`,
        "test@test.com",
        orgId,
        "member",
        ownerId,
        now,
        now + 86400000
      )
      .run();

    // Create R2 objects
    await env.R2.put(`orgs/${orgId}/docs/test.pdf`, "test content");
    await env.R2.put(`orgs/${orgId}/audit/2025/01/01/entry.json`, "{}");

    // Delete the org
    const result = await deleteOrg(env.DB, env.R2, orgId, ownerId);

    expect(result.success).toBe(true);
    expect("deletedRecords" in result).toBe(true);

    if ("deletedRecords" in result) {
      expect(result.deletedRecords.org).toBe(true);
      expect(result.deletedRecords.members).toBe(2);
      expect(result.deletedRecords.invitations).toBe(1);
      expect(result.deletedR2Objects).toBe(2);
    }

    // Verify org is deleted
    const org = await env.DB.prepare("SELECT id FROM org WHERE id = ?")
      .bind(orgId)
      .first();
    expect(org).toBeNull();

    // Verify members are deleted (cascade)
    const members = await env.DB.prepare(
      "SELECT COUNT(*) as count FROM org_members WHERE org_id = ?"
    )
      .bind(orgId)
      .first<{ count: number }>();
    expect(members?.count).toBe(0);

    // Verify invitations are deleted (cascade)
    const invitations = await env.DB.prepare(
      "SELECT COUNT(*) as count FROM invitations WHERE org_id = ?"
    )
      .bind(orgId)
      .first<{ count: number }>();
    expect(invitations?.count).toBe(0);

    // Verify R2 objects are deleted
    const r2List = await env.R2.list({ prefix: `orgs/${orgId}/` });
    expect(r2List.objects.length).toBe(0);
  });

  it("cleans up R2 objects with pagination", async () => {
    // Create an org with many R2 objects to test pagination
    const orgId = `delete-pagination-${Date.now()}`;
    const ownerId = `pagination-owner-${Date.now()}`;
    const now = Date.now();

    await env.DB.prepare("INSERT INTO org (id, name) VALUES (?, ?)")
      .bind(orgId, "Pagination Test Org")
      .run();

    await env.DB.prepare(
      `INSERT INTO user (id, email, name, email_verified, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?)`
    )
      .bind(ownerId, `${ownerId}@test.com`, "Owner", now, now)
      .run();

    await env.DB.prepare(
      `INSERT INTO org_members (id, user_id, org_id, role, is_owner, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(`om-${ownerId}`, ownerId, orgId, "admin", 1, now)
      .run();

    // Create 5 R2 objects
    for (let i = 0; i < 5; i++) {
      await env.R2.put(`orgs/${orgId}/docs/file${i}.txt`, `content ${i}`);
    }

    // Verify objects exist
    const beforeList = await env.R2.list({ prefix: `orgs/${orgId}/` });
    expect(beforeList.objects.length).toBe(5);

    // Delete the org
    const result = await deleteOrg(env.DB, env.R2, orgId, ownerId);

    expect(result.success).toBe(true);
    if ("deletedR2Objects" in result) {
      expect(result.deletedR2Objects).toBe(5);
    }

    // Verify all R2 objects are deleted
    const afterList = await env.R2.list({ prefix: `orgs/${orgId}/` });
    expect(afterList.objects.length).toBe(0);
  });
});
