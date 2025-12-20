import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import {
  createInvitation,
  findPendingInvitation,
  processInvitation,
  getOrgInvitations,
  revokeInvitation,
  hasPendingInvitation,
} from "../src/services/invitations";

describe("Invitations", () => {
  const testOrgId = crypto.randomUUID();
  const adminUserId = crypto.randomUUID();

  beforeAll(async () => {
    await env.DB.prepare(
      `INSERT INTO org (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`
    )
      .bind(testOrgId, "Test Law Firm", Date.now(), Date.now())
      .run();
    await env.DB.prepare(
      `INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(
        adminUserId,
        "Admin User",
        "admin@lawfirm.com",
        1,
        Date.now(),
        Date.now()
      )
      .run();
  });

  it("creates an invitation", async () => {
    const email = `invite-${Date.now()}@example.com`;
    const { id, expiresAt } = await createInvitation(env.DB, {
      email,
      orgId: testOrgId,
      role: "member",
      invitedBy: adminUserId,
    });
    expect(id).toBeDefined();
    expect(expiresAt).toBeGreaterThan(Date.now());

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
      email: `custom-${Date.now()}@example.com`,
      orgId: testOrgId,
      role: "admin",
      invitedBy: adminUserId,
      expiresInDays: 14,
    });
    expect(expiresAt).toBeGreaterThan(Date.now() + 13 * 24 * 60 * 60 * 1000);
    expect(expiresAt).toBeLessThan(Date.now() + 15 * 24 * 60 * 60 * 1000);
  });

  it("finds pending invitation by email", async () => {
    const email = `pending-${Date.now()}@example.com`;
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
    expect(
      await findPendingInvitation(env.DB, "nobody@example.com")
    ).toBeNull();
  });

  it("ignores expired invitations", async () => {
    const email = `expired-${Date.now()}@example.com`;
    const pastTime = Date.now() - 1000;
    await env.DB.prepare(
      `INSERT INTO invitations (id, email, org_id, role, invited_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
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
    expect(await findPendingInvitation(env.DB, email)).toBeNull();
  });

  it("processes invitation on user signup", async () => {
    const email = `newuser-${Date.now()}@example.com`;
    const newUserId = crypto.randomUUID();
    await createInvitation(env.DB, {
      email,
      orgId: testOrgId,
      role: "member",
      invitedBy: adminUserId,
    });
    await env.DB.prepare(
      `INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(newUserId, "New User", email, 1, Date.now(), Date.now())
      .run();

    const result = await processInvitation(env.DB, { id: newUserId, email });
    expect(result?.orgId).toBe(testOrgId);

    const membership = await env.DB.prepare(
      `SELECT role FROM org_members WHERE user_id = ? AND org_id = ?`
    )
      .bind(newUserId, testOrgId)
      .first<{ role: string }>();
    expect(membership?.role).toBe("member");

    const invitation = await env.DB.prepare(
      `SELECT accepted_at FROM invitations WHERE email = ?`
    )
      .bind(email)
      .first<{ accepted_at: number }>();
    expect(invitation?.accepted_at).toBeGreaterThan(0);
  });

  it("returns null when processing without invitation", async () => {
    expect(
      await processInvitation(env.DB, {
        id: crypto.randomUUID(),
        email: `noinvite-${Date.now()}@example.com`,
      })
    ).toBeNull();
  });

  it("gets all pending invitations for an org", async () => {
    const orgId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO org (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`
    )
      .bind(orgId, "Invitations Org", Date.now(), Date.now())
      .run();
    await createInvitation(env.DB, {
      email: `list1-${Date.now()}@example.com`,
      orgId,
      role: "member",
      invitedBy: adminUserId,
    });
    await createInvitation(env.DB, {
      email: `list2-${Date.now()}@example.com`,
      orgId,
      role: "admin",
      invitedBy: adminUserId,
    });

    const invitations = await getOrgInvitations(env.DB, orgId);
    expect(invitations.length).toBe(2);
    expect(invitations.some((i) => i.role === "member")).toBe(true);
    expect(invitations.some((i) => i.role === "admin")).toBe(true);
  });

  it("revokes an invitation", async () => {
    const email = `revoke-${Date.now()}@example.com`;
    const { id } = await createInvitation(env.DB, {
      email,
      orgId: testOrgId,
      role: "member",
      invitedBy: adminUserId,
    });
    expect(await findPendingInvitation(env.DB, email)).not.toBeNull();
    expect(await revokeInvitation(env.DB, id)).toBe(true);
    expect(await findPendingInvitation(env.DB, email)).toBeNull();
  });

  it("returns false when revoking non-existent invitation", async () => {
    expect(await revokeInvitation(env.DB, crypto.randomUUID())).toBe(false);
  });

  it("checks for pending invitation to org", async () => {
    const email = `check-${Date.now()}@example.com`;
    expect(await hasPendingInvitation(env.DB, email, testOrgId)).toBe(false);
    await createInvitation(env.DB, {
      email,
      orgId: testOrgId,
      role: "member",
      invitedBy: adminUserId,
    });
    expect(await hasPendingInvitation(env.DB, email, testOrgId)).toBe(true);
    expect(await hasPendingInvitation(env.DB, email, crypto.randomUUID())).toBe(
      false
    );
  });

  it("normalizes email to lowercase", async () => {
    const baseEmail = `uppercase-${Date.now()}`;
    await createInvitation(env.DB, {
      email: `${baseEmail}@EXAMPLE.COM`,
      orgId: testOrgId,
      role: "member",
      invitedBy: adminUserId,
    });
    expect(
      await findPendingInvitation(env.DB, `${baseEmail}@example.com`)
    ).not.toBeNull();
  });
});
