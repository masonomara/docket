import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import {
  getOrgMembership,
  getOrgMembers,
  removeUserFromOrg,
  transferOwnership,
} from "../src/services/org-membership";

// ============================================================================
// Test Setup
// ============================================================================

const TEST_ORG_ID = "test-org-membership";
const OWNER_ID = "user-owner";
const ADMIN_ID = "user-admin";
const MEMBER_ID = "user-member";
const NON_MEMBER_ID = "user-nonmember";

beforeAll(async () => {
  const now = Date.now();

  // Create test org
  await env.DB.prepare("INSERT OR IGNORE INTO org (id, name) VALUES (?, ?)")
    .bind(TEST_ORG_ID, "Test Org")
    .run();

  // Create test users
  const users = [
    { id: OWNER_ID, email: "owner@test.com", name: "Owner" },
    { id: ADMIN_ID, email: "admin@test.com", name: "Admin" },
    { id: MEMBER_ID, email: "member@test.com", name: "Member" },
    { id: NON_MEMBER_ID, email: "nonmember@test.com", name: "Non Member" },
  ];

  for (const user of users) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO user (id, email, name, email_verified, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?)`
    )
      .bind(user.id, user.email, user.name, now, now)
      .run();
  }

  // Create org memberships (owner, admin, member)
  await env.DB.prepare(
    `INSERT OR IGNORE INTO org_members (id, user_id, org_id, role, is_owner, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind("om-owner", OWNER_ID, TEST_ORG_ID, "admin", 1, now)
    .run();

  await env.DB.prepare(
    `INSERT OR IGNORE INTO org_members (id, user_id, org_id, role, is_owner, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind("om-admin", ADMIN_ID, TEST_ORG_ID, "admin", 0, now)
    .run();

  await env.DB.prepare(
    `INSERT OR IGNORE INTO org_members (id, user_id, org_id, role, is_owner, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind("om-member", MEMBER_ID, TEST_ORG_ID, "member", 0, now)
    .run();
});

// ============================================================================
// getOrgMembership Tests
// ============================================================================

describe("getOrgMembership", () => {
  it("returns membership for existing member", async () => {
    const membership = await getOrgMembership(env.DB, MEMBER_ID, TEST_ORG_ID);

    expect(membership).not.toBeNull();
    expect(membership?.userId).toBe(MEMBER_ID);
    expect(membership?.orgId).toBe(TEST_ORG_ID);
    expect(membership?.role).toBe("member");
    expect(membership?.isOwner).toBe(false);
  });

  it("returns owner flag correctly", async () => {
    const membership = await getOrgMembership(env.DB, OWNER_ID, TEST_ORG_ID);

    expect(membership).not.toBeNull();
    expect(membership?.isOwner).toBe(true);
    expect(membership?.role).toBe("admin");
  });

  it("returns null for non-member", async () => {
    const membership = await getOrgMembership(
      env.DB,
      NON_MEMBER_ID,
      TEST_ORG_ID
    );

    expect(membership).toBeNull();
  });
});

// ============================================================================
// getOrgMembers Tests
// ============================================================================

describe("getOrgMembers", () => {
  it("returns all members of an org", async () => {
    const members = await getOrgMembers(env.DB, TEST_ORG_ID);

    expect(members.length).toBe(3);

    const userIds = members.map((m) => m.userId);
    expect(userIds).toContain(OWNER_ID);
    expect(userIds).toContain(ADMIN_ID);
    expect(userIds).toContain(MEMBER_ID);
  });

  it("returns empty array for org with no members", async () => {
    const members = await getOrgMembers(env.DB, "nonexistent-org");

    expect(members).toEqual([]);
  });
});

// ============================================================================
// removeUserFromOrg Tests
// ============================================================================

describe("removeUserFromOrg", () => {
  it("successfully removes member from org", async () => {
    // Create a temporary member to remove
    const tempMemberId = `temp-member-${Date.now()}`;
    const now = Date.now();

    await env.DB.prepare(
      `INSERT INTO user (id, email, name, email_verified, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?)`
    )
      .bind(tempMemberId, `${tempMemberId}@test.com`, "Temp", now, now)
      .run();

    await env.DB.prepare(
      `INSERT INTO org_members (id, user_id, org_id, role, is_owner, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(`om-${tempMemberId}`, tempMemberId, TEST_ORG_ID, "member", 0, now)
      .run();

    const result = await removeUserFromOrg(env.DB, tempMemberId, TEST_ORG_ID);

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();

    // Verify removal
    const membership = await getOrgMembership(
      env.DB,
      tempMemberId,
      TEST_ORG_ID
    );
    expect(membership).toBeNull();
  });

  it("successfully removes admin (non-owner) from org", async () => {
    // Create a temporary admin to remove
    const tempAdminId = `temp-admin-${Date.now()}`;
    const now = Date.now();

    await env.DB.prepare(
      `INSERT INTO user (id, email, name, email_verified, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?)`
    )
      .bind(tempAdminId, `${tempAdminId}@test.com`, "Temp Admin", now, now)
      .run();

    await env.DB.prepare(
      `INSERT INTO org_members (id, user_id, org_id, role, is_owner, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(`om-${tempAdminId}`, tempAdminId, TEST_ORG_ID, "admin", 0, now)
      .run();

    const result = await removeUserFromOrg(env.DB, tempAdminId, TEST_ORG_ID);

    expect(result.success).toBe(true);
  });

  it("blocks owner from leaving", async () => {
    const result = await removeUserFromOrg(env.DB, OWNER_ID, TEST_ORG_ID);

    expect(result.success).toBe(false);
    expect(result.error).toBe("is_owner");
    expect(result.message).toContain("Transfer ownership");

    // Verify owner still exists
    const membership = await getOrgMembership(env.DB, OWNER_ID, TEST_ORG_ID);
    expect(membership).not.toBeNull();
  });

  it("returns error for non-member", async () => {
    const result = await removeUserFromOrg(env.DB, NON_MEMBER_ID, TEST_ORG_ID);

    expect(result.success).toBe(false);
    expect(result.error).toBe("user_not_member");
  });
});

// ============================================================================
// transferOwnership Tests
// ============================================================================

describe("transferOwnership", () => {
  it("successfully transfers ownership to another admin", async () => {
    // Create a fresh org for this test
    const testOrgId = `transfer-test-${Date.now()}`;
    const ownerId = `transfer-owner-${Date.now()}`;
    const targetId = `transfer-target-${Date.now()}`;
    const now = Date.now();

    await env.DB.prepare("INSERT INTO org (id, name) VALUES (?, ?)")
      .bind(testOrgId, "Transfer Test Org")
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
      .bind(targetId, `${targetId}@test.com`, "Target", now, now)
      .run();

    await env.DB.prepare(
      `INSERT INTO org_members (id, user_id, org_id, role, is_owner, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(`om-${ownerId}`, ownerId, testOrgId, "admin", 1, now)
      .run();

    await env.DB.prepare(
      `INSERT INTO org_members (id, user_id, org_id, role, is_owner, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(`om-${targetId}`, targetId, testOrgId, "admin", 0, now)
      .run();

    const result = await transferOwnership(
      env.DB,
      testOrgId,
      ownerId,
      targetId
    );

    expect(result.success).toBe(true);

    // Verify ownership transferred
    const oldOwner = await getOrgMembership(env.DB, ownerId, testOrgId);
    const newOwner = await getOrgMembership(env.DB, targetId, testOrgId);

    expect(oldOwner?.isOwner).toBe(false);
    expect(newOwner?.isOwner).toBe(true);
  });

  it("blocks if caller is not owner", async () => {
    const result = await transferOwnership(
      env.DB,
      TEST_ORG_ID,
      ADMIN_ID,
      MEMBER_ID
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("not_owner");
  });

  it("blocks if target is not a member", async () => {
    const result = await transferOwnership(
      env.DB,
      TEST_ORG_ID,
      OWNER_ID,
      NON_MEMBER_ID
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("target_not_member");
  });

  it("blocks if target is not an admin", async () => {
    const result = await transferOwnership(
      env.DB,
      TEST_ORG_ID,
      OWNER_ID,
      MEMBER_ID
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("target_not_admin");
  });
});
