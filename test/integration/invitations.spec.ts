import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import {
  createInvitation,
  findPendingInvitation,
  processInvitation,
  getOrgInvitations,
  revokeInvitation,
  hasPendingInvitation,
} from "../../src/services/invitations";

// ============================================================================
// Test Helpers
// ============================================================================

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Generates a unique test email
 */
function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}@example.com`;
}

/**
 * Creates a test user in the database
 */
async function createTestUser(
  id: string,
  email: string,
  name: string
): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(id, name, email, 1, now, now)
    .run();
}

/**
 * Creates a test organization in the database
 */
async function createTestOrg(id: string, name: string): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO org (id, name, created_at, updated_at)
     VALUES (?, ?, ?, ?)`
  )
    .bind(id, name, now, now)
    .run();
}

// ============================================================================
// Invitation Tests
// ============================================================================

describe("Invitations", () => {
  const testOrgId = crypto.randomUUID();
  const adminUserId = crypto.randomUUID();

  beforeAll(async () => {
    await createTestOrg(testOrgId, "Test Law Firm");
    await createTestUser(adminUserId, "admin@lawfirm.com", "Admin User");
  });

  // --------------------------------------------------------------------------
  // Creation Tests
  // --------------------------------------------------------------------------

  it("creates an invitation", async () => {
    const email = uniqueEmail("invite");

    const { id, expiresAt } = await createInvitation(env.DB, {
      email,
      orgId: testOrgId,
      role: "member",
      invitedBy: adminUserId,
    });

    expect(id).toBeDefined();
    expect(expiresAt).toBeGreaterThan(Date.now());

    // Verify stored data
    const stored = await env.DB.prepare(
      `SELECT email, org_id, role FROM invitations WHERE id = ?`
    )
      .bind(id)
      .first<{ email: string; org_id: string; role: string }>();

    expect(stored?.email).toBe(email.toLowerCase());
    expect(stored?.role).toBe("member");
  });

  it("creates invitation with custom expiration", async () => {
    const { expiresAt } = await createInvitation(env.DB, {
      email: uniqueEmail("custom"),
      orgId: testOrgId,
      role: "admin",
      invitedBy: adminUserId,
      expiresInDays: 14,
    });

    // Should expire between 13 and 15 days from now
    expect(expiresAt).toBeGreaterThan(Date.now() + 13 * MS_PER_DAY);
    expect(expiresAt).toBeLessThan(Date.now() + 15 * MS_PER_DAY);
  });

  // --------------------------------------------------------------------------
  // Lookup Tests
  // --------------------------------------------------------------------------

  it("finds pending invitation by email", async () => {
    const email = uniqueEmail("pending");

    await createInvitation(env.DB, {
      email,
      orgId: testOrgId,
      role: "member",
      invitedBy: adminUserId,
    });

    const invitation = await findPendingInvitation(env.DB, email);

    expect(invitation?.orgId).toBe(testOrgId);
    expect(invitation?.role).toBe("member");
  });

  it("returns null for non-existent invitation", async () => {
    const result = await findPendingInvitation(env.DB, "nobody@example.com");

    expect(result).toBeNull();
  });

  it("ignores expired invitations", async () => {
    const email = uniqueEmail("expired");
    const pastTime = Date.now() - 1000;

    // Insert an already-expired invitation directly
    await env.DB.prepare(
      `INSERT INTO invitations (id, email, org_id, role, invited_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        crypto.randomUUID(),
        email,
        testOrgId,
        "member",
        adminUserId,
        pastTime - 1000,
        pastTime
      )
      .run();

    const result = await findPendingInvitation(env.DB, email);

    expect(result).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Processing Tests
  // --------------------------------------------------------------------------

  it("processes invitation on user signup", async () => {
    const email = uniqueEmail("newuser");
    const newUserId = crypto.randomUUID();

    // Create invitation
    await createInvitation(env.DB, {
      email,
      orgId: testOrgId,
      role: "member",
      invitedBy: adminUserId,
    });

    // Create user
    await createTestUser(newUserId, email, "New User");

    // Process invitation
    const result = await processInvitation(env.DB, { id: newUserId, email });

    expect(result?.orgId).toBe(testOrgId);

    // Verify org membership was created
    const membership = await env.DB.prepare(
      `SELECT role FROM org_members WHERE user_id = ? AND org_id = ?`
    )
      .bind(newUserId, testOrgId)
      .first<{ role: string }>();

    expect(membership?.role).toBe("member");

    // Verify invitation was marked as accepted
    const invitation = await env.DB.prepare(
      `SELECT accepted_at FROM invitations WHERE email = ?`
    )
      .bind(email)
      .first<{ accepted_at: number }>();

    expect(invitation?.accepted_at).toBeGreaterThan(0);
  });

  it("returns null when processing without invitation", async () => {
    const result = await processInvitation(env.DB, {
      id: crypto.randomUUID(),
      email: uniqueEmail("noinvite"),
    });

    expect(result).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Listing Tests
  // --------------------------------------------------------------------------

  it("gets all pending invitations for an org", async () => {
    const orgId = crypto.randomUUID();
    await createTestOrg(orgId, "Invitations Org");

    // Create two invitations
    await createInvitation(env.DB, {
      email: uniqueEmail("list1"),
      orgId,
      role: "member",
      invitedBy: adminUserId,
    });

    await createInvitation(env.DB, {
      email: uniqueEmail("list2"),
      orgId,
      role: "admin",
      invitedBy: adminUserId,
    });

    const invitations = await getOrgInvitations(env.DB, orgId);

    expect(invitations.length).toBe(2);
    expect(invitations.some((inv) => inv.role === "member")).toBe(true);
    expect(invitations.some((inv) => inv.role === "admin")).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Revocation Tests
  // --------------------------------------------------------------------------

  it("revokes an invitation", async () => {
    const email = uniqueEmail("revoke");

    const { id } = await createInvitation(env.DB, {
      email,
      orgId: testOrgId,
      role: "member",
      invitedBy: adminUserId,
    });

    // Verify it exists
    expect(await findPendingInvitation(env.DB, email)).not.toBeNull();

    // Revoke it
    const revoked = await revokeInvitation(env.DB, id);
    expect(revoked).toBe(true);

    // Verify it's gone
    expect(await findPendingInvitation(env.DB, email)).toBeNull();
  });

  it("returns false when revoking non-existent invitation", async () => {
    const result = await revokeInvitation(env.DB, crypto.randomUUID());

    expect(result).toBe(false);
  });

  // --------------------------------------------------------------------------
  // Duplicate Check Tests
  // --------------------------------------------------------------------------

  it("checks for pending invitation to org", async () => {
    const email = uniqueEmail("check");

    // Should not exist initially
    expect(await hasPendingInvitation(env.DB, email, testOrgId)).toBe(false);

    // Create invitation
    await createInvitation(env.DB, {
      email,
      orgId: testOrgId,
      role: "member",
      invitedBy: adminUserId,
    });

    // Should exist now
    expect(await hasPendingInvitation(env.DB, email, testOrgId)).toBe(true);

    // Should not exist for different org
    expect(await hasPendingInvitation(env.DB, email, crypto.randomUUID())).toBe(
      false
    );
  });

  // --------------------------------------------------------------------------
  // Email Normalization Tests
  // --------------------------------------------------------------------------

  it("normalizes email to lowercase", async () => {
    const baseEmail = `uppercase-${Date.now()}`;

    // Create with uppercase
    await createInvitation(env.DB, {
      email: `${baseEmail}@EXAMPLE.COM`,
      orgId: testOrgId,
      role: "member",
      invitedBy: adminUserId,
    });

    // Find with lowercase
    const result = await findPendingInvitation(
      env.DB,
      `${baseEmail}@example.com`
    );

    expect(result).not.toBeNull();
  });
});
