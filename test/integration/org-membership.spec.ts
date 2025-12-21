import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import {
  getOrgMembership,
  getOrgMembers,
  removeUserFromOrg,
  transferOwnership,
} from "../../src/services/org-membership";

// Test data constants
const TEST_ORG_ID = "test-org-membership";
const OWNER_USER_ID = "user-owner";
const ADMIN_USER_ID = "user-admin";
const MEMBER_USER_ID = "user-member";
const NON_MEMBER_USER_ID = "user-nonmember";

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
    .bind(TEST_ORG_ID, "Test Org")
    .run();

  // Create test users
  await Promise.all([
    insertTestUser(OWNER_USER_ID, now),
    insertTestUser(ADMIN_USER_ID, now),
    insertTestUser(MEMBER_USER_ID, now),
    insertTestUser(NON_MEMBER_USER_ID, now),
  ]);

  // Add users to org with different roles
  await Promise.all([
    insertTestMember("om-owner", OWNER_USER_ID, TEST_ORG_ID, "admin", 1, now),
    insertTestMember("om-admin", ADMIN_USER_ID, TEST_ORG_ID, "admin", 0, now),
    insertTestMember(
      "om-member",
      MEMBER_USER_ID,
      TEST_ORG_ID,
      "member",
      0,
      now
    ),
  ]);
});

describe("getOrgMembership", () => {
  it("returns membership for existing member", async () => {
    const membership = await getOrgMembership(
      env.DB,
      MEMBER_USER_ID,
      TEST_ORG_ID
    );

    expect(membership?.userId).toBe(MEMBER_USER_ID);
    expect(membership?.role).toBe("member");
    expect(membership?.isOwner).toBe(false);
  });

  it("returns owner flag correctly", async () => {
    const membership = await getOrgMembership(
      env.DB,
      OWNER_USER_ID,
      TEST_ORG_ID
    );

    expect(membership?.isOwner).toBe(true);
  });

  it("returns null for non-member", async () => {
    const membership = await getOrgMembership(
      env.DB,
      NON_MEMBER_USER_ID,
      TEST_ORG_ID
    );

    expect(membership).toBeNull();
  });
});

describe("getOrgMembers", () => {
  it("returns all members of the org", async () => {
    const members = await getOrgMembers(env.DB, TEST_ORG_ID);

    expect(members.length).toBe(3);

    const userIds = members.map((m) => m.userId);
    expect(userIds).toContain(OWNER_USER_ID);
    expect(userIds).toContain(ADMIN_USER_ID);
    expect(userIds).toContain(MEMBER_USER_ID);
  });

  it("returns empty array for nonexistent org", async () => {
    const members = await getOrgMembers(env.DB, "nonexistent-org");

    expect(members).toEqual([]);
  });
});

describe("removeUserFromOrg", () => {
  it("successfully removes a regular member", async () => {
    // Create a temporary user to remove
    const tempUserId = `temp-${Date.now()}`;
    const now = Date.now();

    await insertTestUser(tempUserId, now);
    await insertTestMember(
      `om-${tempUserId}`,
      tempUserId,
      TEST_ORG_ID,
      "member",
      0,
      now
    );

    const result = await removeUserFromOrg(env.DB, tempUserId, TEST_ORG_ID);

    expect(result.success).toBe(true);

    // Verify user is no longer a member
    const membership = await getOrgMembership(env.DB, tempUserId, TEST_ORG_ID);
    expect(membership).toBeNull();
  });

  it("blocks removing the owner", async () => {
    const result = await removeUserFromOrg(env.DB, OWNER_USER_ID, TEST_ORG_ID);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("is_owner");
    }
  });

  it("returns error for non-member", async () => {
    const result = await removeUserFromOrg(
      env.DB,
      NON_MEMBER_USER_ID,
      TEST_ORG_ID
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("user_not_member");
    }
  });
});

describe("transferOwnership", () => {
  it("successfully transfers ownership to an admin", async () => {
    // Create a fresh org for this test
    const testOrgId = `xfer-${Date.now()}`;
    const originalOwnerId = `owner-${Date.now()}`;
    const newOwnerId = `target-${Date.now()}`;
    const now = Date.now();

    await env.DB.prepare("INSERT INTO org (id, name) VALUES (?, ?)")
      .bind(testOrgId, "Transfer Test Org")
      .run();

    await Promise.all([
      insertTestUser(originalOwnerId, now),
      insertTestUser(newOwnerId, now),
    ]);

    await Promise.all([
      insertTestMember(
        `om-${originalOwnerId}`,
        originalOwnerId,
        testOrgId,
        "admin",
        1,
        now
      ),
      insertTestMember(
        `om-${newOwnerId}`,
        newOwnerId,
        testOrgId,
        "admin",
        0,
        now
      ),
    ]);

    const result = await transferOwnership(
      env.DB,
      testOrgId,
      originalOwnerId,
      newOwnerId
    );

    expect(result.success).toBe(true);

    // Verify new owner
    const newOwnerMembership = await getOrgMembership(
      env.DB,
      newOwnerId,
      testOrgId
    );
    expect(newOwnerMembership?.isOwner).toBe(true);
  });

  it("blocks transfer by non-owner", async () => {
    const result = await transferOwnership(
      env.DB,
      TEST_ORG_ID,
      ADMIN_USER_ID,
      MEMBER_USER_ID
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("not_owner");
    }
  });

  it("blocks transfer to non-member", async () => {
    const result = await transferOwnership(
      env.DB,
      TEST_ORG_ID,
      OWNER_USER_ID,
      NON_MEMBER_USER_ID
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("target_not_member");
    }
  });

  it("blocks transfer to non-admin member", async () => {
    const result = await transferOwnership(
      env.DB,
      TEST_ORG_ID,
      OWNER_USER_ID,
      MEMBER_USER_ID
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("target_not_admin");
    }
  });
});
