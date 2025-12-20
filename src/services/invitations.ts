export type OrgRole = "admin" | "member";

export interface Invitation {
  id: string;
  email: string;
  orgId: string;
  role: OrgRole;
  invitedBy: string;
  createdAt: number;
  expiresAt: number;
  acceptedAt: number | null;
}

export interface CreateInvitationInput {
  email: string;
  orgId: string;
  role: OrgRole;
  invitedBy: string;
  expiresInDays?: number;
}

export async function createInvitation(
  db: D1Database,
  input: CreateInvitationInput
): Promise<{ id: string; expiresAt: number }> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const expiresAt = now + (input.expiresInDays ?? 7) * 24 * 60 * 60 * 1000;

  await db
    .prepare(
      `INSERT INTO invitations (id, email, org_id, role, invited_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      input.email.toLowerCase(),
      input.orgId,
      input.role,
      input.invitedBy,
      now,
      expiresAt
    )
    .run();

  return { id, expiresAt };
}

export async function findPendingInvitation(
  db: D1Database,
  email: string
): Promise<{ id: string; orgId: string; role: OrgRole } | null> {
  const result = await db
    .prepare(
      `SELECT id, org_id, role FROM invitations WHERE email = ? AND accepted_at IS NULL AND expires_at > ?`
    )
    .bind(email.toLowerCase(), Date.now())
    .first<{ id: string; org_id: string; role: OrgRole }>();

  return result
    ? { id: result.id, orgId: result.org_id, role: result.role }
    : null;
}

export async function processInvitation(
  db: D1Database,
  user: { id: string; email: string }
): Promise<{ orgId: string; role: OrgRole } | null> {
  const invitation = await findPendingInvitation(db, user.email);
  if (!invitation) return null;

  const now = Date.now();
  await db.batch([
    db
      .prepare(
        `INSERT INTO org_members (id, org_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)`
      )
      .bind(
        crypto.randomUUID(),
        invitation.orgId,
        user.id,
        invitation.role,
        now
      ),
    db
      .prepare(`UPDATE invitations SET accepted_at = ? WHERE id = ?`)
      .bind(now, invitation.id),
  ]);

  return { orgId: invitation.orgId, role: invitation.role };
}

export async function getOrgInvitations(
  db: D1Database,
  orgId: string
): Promise<Invitation[]> {
  const result = await db
    .prepare(
      `SELECT id, email, org_id, role, invited_by, created_at, expires_at, accepted_at FROM invitations WHERE org_id = ? AND accepted_at IS NULL AND expires_at > ? ORDER BY created_at DESC`
    )
    .bind(orgId, Date.now())
    .all<{
      id: string;
      email: string;
      org_id: string;
      role: OrgRole;
      invited_by: string;
      created_at: number;
      expires_at: number;
      accepted_at: number | null;
    }>();

  return result.results.map((r) => ({
    id: r.id,
    email: r.email,
    orgId: r.org_id,
    role: r.role,
    invitedBy: r.invited_by,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    acceptedAt: r.accepted_at,
  }));
}

export async function revokeInvitation(
  db: D1Database,
  invitationId: string
): Promise<boolean> {
  const result = await db
    .prepare(`DELETE FROM invitations WHERE id = ? AND accepted_at IS NULL`)
    .bind(invitationId)
    .run();
  return result.meta.changes > 0;
}

export async function hasPendingInvitation(
  db: D1Database,
  email: string,
  orgId: string
): Promise<boolean> {
  const result = await db
    .prepare(
      `SELECT 1 FROM invitations WHERE email = ? AND org_id = ? AND accepted_at IS NULL AND expires_at > ?`
    )
    .bind(email.toLowerCase(), orgId, Date.now())
    .first();
  return result !== null;
}
