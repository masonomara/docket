import { useState } from "react";
import { useRevalidator } from "react-router";
import type { Route } from "./+types/org.members";
import { apiFetch, ENDPOINTS } from "~/lib/api";
import { API_URL } from "~/lib/auth-client";
import { requireOrgAuth } from "~/lib/loader-auth";
import type { OrgMember, PendingInvitation } from "~/lib/types";
import { AppLayout } from "~/components/AppLayout";
import { PageLayout } from "~/components/PageLayout";
import { Plus } from "lucide-react";

// -----------------------------------------------------------------------------
// Loader
// -----------------------------------------------------------------------------

export async function loader({ request, context }: Route.LoaderArgs) {
  const { user, org } = await requireOrgAuth(request, context, {
    requireAdmin: true,
  });

  const cookie = request.headers.get("cookie") || "";

  const [membersResponse, invitationsResponse] = await Promise.all([
    apiFetch(context, ENDPOINTS.org.members, cookie),
    apiFetch(context, ENDPOINTS.org.invitations, cookie),
  ]);

  let members: OrgMember[] = [];
  let invitations: PendingInvitation[] = [];
  let loadError: string | null = null;

  if (membersResponse.ok) {
    members = (await membersResponse.json()) as OrgMember[];
  } else {
    loadError = "Failed to load members.";
  }

  if (invitationsResponse.ok) {
    invitations = (await invitationsResponse.json()) as PendingInvitation[];
  } else if (!loadError) {
    loadError = "Failed to load invitations.";
  }

  return { user, org, members, invitations, loadError };
}

// -----------------------------------------------------------------------------
// Page Component
// -----------------------------------------------------------------------------

export default function MembersPage({ loaderData }: Route.ComponentProps) {
  const { user, org, members, invitations, loadError } = loaderData;
  const revalidator = useRevalidator();

  // Modal state
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [showTransferModal, setShowTransferModal] = useState(false);
  const [transferTarget, setTransferTarget] = useState<OrgMember | null>(null);

  // Feedback state
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // ---------------------------------------------------------------------------
  // API Helpers
  // ---------------------------------------------------------------------------

  async function makeApiRequest(
    url: string,
    method: string,
    body?: object
  ): Promise<void> {
    const response = await fetch(`${API_URL}${url}`, {
      method,
      credentials: "include",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const data = (await response.json()) as { error?: string };
      throw new Error(data.error || "Request failed");
    }
  }

  async function runAction(
    action: () => Promise<void>,
    successMessage: string
  ): Promise<void> {
    setError(null);
    setSuccess(null);

    try {
      await action();
      setSuccess(successMessage);
      revalidator.revalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    }
  }

  // ---------------------------------------------------------------------------
  // Event Handlers
  // ---------------------------------------------------------------------------

  async function handleRoleChange(member: OrgMember, newRole: string) {
    await runAction(
      () =>
        makeApiRequest(ENDPOINTS.org.member(member.userId), "PATCH", {
          role: newRole,
        }),
      "Role updated"
    );
  }

  async function handleRemoveMember(member: OrgMember) {
    const confirmed = confirm(`Remove ${member.name} from the firm?`);
    if (!confirmed) return;

    await runAction(
      () => makeApiRequest(ENDPOINTS.org.member(member.userId), "DELETE"),
      "Member removed"
    );
  }

  async function handleRevokeInvitation(invitation: PendingInvitation) {
    const confirmed = confirm(`Revoke invitation to ${invitation.email}?`);
    if (!confirmed) return;

    await runAction(
      () => makeApiRequest(ENDPOINTS.org.invitation(invitation.id), "DELETE"),
      "Invitation revoked"
    );
  }

  function openTransferModal(member: OrgMember) {
    setTransferTarget(member);
    setShowTransferModal(true);
  }

  function closeTransferModal() {
    setShowTransferModal(false);
    setTransferTarget(null);
  }

  function handleInviteSuccess() {
    setShowInviteModal(false);
    setSuccess("Invitation sent");
    revalidator.revalidate();
  }

  function handleTransferSuccess() {
    closeTransferModal();
    setSuccess("Ownership transferred");
    revalidator.revalidate();
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <AppLayout org={org} currentPath="/org/members">
      <PageLayout
        title="Members"
        actions={
          <button
            onClick={() => setShowInviteModal(true)}
            className="btn btn-primary btn-sm"
          >
            <Plus strokeWidth={1.75} size={16} />
            Invite Member
          </button>
        }
      >
        {loadError && (
          <div className="alert alert-error">
            {loadError}{" "}
            <button
              onClick={() => revalidator.revalidate()}
              className="link-button"
            >
              Retry
            </button>
          </div>
        )}
        {error && <div className="alert alert-error">{error}</div>}
        {success && <div className="alert alert-success">{success}</div>}

        {/* Current Members */}
        <section className="section">
          <div className="section-header">
            <h2 className="text-title-3">Current Members ({members.length})</h2>
          </div>

          {members.length === 0 ? (
            <div className="empty-state">No members found</div>
          ) : (
            <div className="tableWrapper">
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Role</th>
                    <th>Joined</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((member) => (
                    <MemberRow
                      key={member.id}
                      member={member}
                      currentUserId={user.id}
                      isCurrentUserOwner={org.isOwner}
                      onRoleChange={handleRoleChange}
                      onRemove={handleRemoveMember}
                      onTransferOwnership={openTransferModal}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Pending Invitations */}
        {invitations.length > 0 && (
          <section className="section">
            <h2 className="text-title-3">
              Pending Invitations ({invitations.length})
            </h2>

            <div className="tableWrapper">
              <table className="table">
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Role</th>
                    <th>Invited By</th>
                    <th>Expires</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {invitations.map((invitation) => (
                    <InvitationRow
                      key={invitation.id}
                      invitation={invitation}
                      onRevoke={handleRevokeInvitation}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* Modals */}
        {showInviteModal && (
          <InviteModal
            onClose={() => setShowInviteModal(false)}
            onSuccess={handleInviteSuccess}
          />
        )}

        {showTransferModal && transferTarget && (
          <TransferOwnershipModal
            targetMember={transferTarget}
            orgName={org.org.name}
            onClose={closeTransferModal}
            onSuccess={handleTransferSuccess}
          />
        )}
      </PageLayout>
    </AppLayout>
  );
}

// -----------------------------------------------------------------------------
// Member Row Component
// -----------------------------------------------------------------------------

interface MemberRowProps {
  member: OrgMember;
  currentUserId: string;
  isCurrentUserOwner: boolean;
  onRoleChange: (member: OrgMember, role: string) => void;
  onRemove: (member: OrgMember) => void;
  onTransferOwnership: (member: OrgMember) => void;
}

function MemberRow({
  member,
  currentUserId,
  isCurrentUserOwner,
  onRoleChange,
  onRemove,
  onTransferOwnership,
}: MemberRowProps) {
  const isSelf = member.userId === currentUserId;
  const canEditRole = !member.isOwner && !isSelf;
  const canTransferOwnership =
    isCurrentUserOwner && !member.isOwner && !isSelf && member.role === "admin";

  const joinedDate = new Date(member.createdAt).toLocaleDateString();

  return (
    <tr>
      {/* Name & Email */}
      <td>
        <div>
          {member.name}
          {isSelf && " (you)"}
        </div>
        <div className="text-secondary">{member.email}</div>
      </td>

      {/* Role */}
      <td>
        {canEditRole ? (
          <select
            className="form-select"
            value={member.role}
            onChange={(e) => onRoleChange(member, e.target.value)}
            style={{ width: "auto", padding: "0.25rem 0.5rem" }}
          >
            <option value="admin">Admin</option>
            <option value="member">Member</option>
          </select>
        ) : (
          <RoleBadge member={member} />
        )}
      </td>

      {/* Joined Date */}
      <td>{joinedDate}</td>

      {/* Actions */}
      <td>
        <div className="btn-group">
          {canTransferOwnership && (
            <button
              className="btn-primary"
              onClick={() => onTransferOwnership(member)}
            >
              Transfer Ownership
            </button>
          )}
          {canEditRole && (
            <button
              className="btn btn-sm btn-danger"
              onClick={() => onRemove(member)}
            >
              Remove
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

function RoleBadge({ member }: { member: OrgMember }) {
  let badgeClass = "badge";

  if (member.isOwner) {
    badgeClass += " badge-owner";
  } else if (member.role === "admin") {
    badgeClass += " badge-admin";
  }

  const label = member.isOwner ? "Owner" : member.role;

  return <span className={badgeClass}>{label}</span>;
}

// -----------------------------------------------------------------------------
// Invitation Row Component
// -----------------------------------------------------------------------------

interface InvitationRowProps {
  invitation: PendingInvitation;
  onRevoke: (invitation: PendingInvitation) => void;
}

function InvitationRow({ invitation, onRevoke }: InvitationRowProps) {
  const expiresDate = new Date(invitation.expiresAt).toLocaleDateString();
  const isExpiringSoon =
    invitation.expiresAt - Date.now() < 24 * 60 * 60 * 1000;

  return (
    <tr>
      <td>{invitation.email}</td>
      <td>
        <span className="badge">{invitation.role}</span>
      </td>
      <td className="text-secondary">{invitation.inviterName}</td>
      <td className="text-secondary">
        {expiresDate}
        {isExpiringSoon && " (soon)"}
      </td>
      <td>
        <button
          className="btn-primary btn-primary-danger"
          onClick={() => onRevoke(invitation)}
        >
          Revoke
        </button>
      </td>
    </tr>
  );
}

// -----------------------------------------------------------------------------
// Invite Modal
// -----------------------------------------------------------------------------

interface InviteModalProps {
  onClose: () => void;
  onSuccess: () => void;
}

function InviteModal({ onClose, onSuccess }: InviteModalProps) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const response = await fetch(`${API_URL}${ENDPOINTS.org.invitations}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, role }),
      });

      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        throw new Error(data.error || "Failed to send invitation");
      }

      onSuccess();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to send invitation"
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Invite a Team Member</h2>

        {error && (
          <div className="alert alert-error" style={{ marginBottom: "-11px" }}>
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="email" className="form-label">
              Email Address
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="form-input"
              placeholder="colleague@lawfirm.com"
              required
            />
          </div>

          <div className="form-group">
            <label htmlFor="role" className="form-label">
              Role
            </label>
            <select
              id="role"
              value={role}
              onChange={(e) => setRole(e.target.value as "admin" | "member")}
              className="form-select"
            >
              <option value="member">Member (read-only)</option>
              <option value="admin">Admin (full access)</option>
            </select>
          </div>

          <div className="modal-actions">
            <button
              type="button"
              onClick={onClose}
              className="btn btn-secondary btn-lg btn-lg-fit"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="btn btn-primary btn-lg btn-lg-fit"
            >
              {isSubmitting ? "Sending..." : "Send Invitation"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Transfer Ownership Modal
// -----------------------------------------------------------------------------

interface TransferOwnershipModalProps {
  targetMember: OrgMember;
  orgName: string;
  onClose: () => void;
  onSuccess: () => void;
}

function TransferOwnershipModal({
  targetMember,
  orgName,
  onClose,
  onSuccess,
}: TransferOwnershipModalProps) {
  const [confirmName, setConfirmName] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isNameMatch = confirmName === orgName;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!isNameMatch) {
      setError("Name does not match");
      return;
    }

    setError(null);
    setIsSubmitting(true);

    try {
      const response = await fetch(
        `${API_URL}${ENDPOINTS.org.transferOwnership}`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            toUserId: targetMember.userId,
            confirmName,
          }),
        }
      );

      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        throw new Error(data.error || "Failed to transfer ownership");
      }

      onSuccess();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to transfer ownership"
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Transfer Ownership</h2>

        <div className="alert alert-error" style={{ marginBottom: "-11px" }}>
          Transfer ownership to <strong>{targetMember.name}</strong> (
          {targetMember.email}). This action cannot be undone.
        </div>

        {error && <div className="alert alert-error">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="confirmName" className="form-label">
              Type <strong>{orgName}</strong> to confirm:
            </label>
            <input
              id="confirmName"
              type="text"
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
              className="form-input"
              placeholder="Firm name"
              required
            />
          </div>

          <div className="modal-actions">
            <button
              type="button"
              onClick={onClose}
              className="btn btn-secondary btn-lg btn-lg-fit"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting || !isNameMatch}
              className="btn btn-danger btn-lg btn-lg-fit"
            >
              {isSubmitting ? "Transferring..." : "Transfer Ownership"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
