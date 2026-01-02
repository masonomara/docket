import { useState, useEffect } from "react";
import { useRevalidator, useNavigate } from "react-router";
import type { Route } from "./+types/_app.org.members";
import { ENDPOINTS } from "~/lib/api";
import { API_URL } from "~/lib/auth-client";
import { childLoader } from "~/lib/loader-auth";
import { useAppContext } from "~/lib/use-app-context";
import type { OrgMember, PendingInvitation } from "~/lib/types";
import { PageLayout } from "~/components/PageLayout";
import { Plus } from "lucide-react";

export const loader = childLoader(async ({ fetch }) => {
  const [membersRes, invitationsRes] = await Promise.all([
    fetch(ENDPOINTS.org.members),
    fetch(ENDPOINTS.org.invitations),
  ]);

  const members = membersRes.ok
    ? ((await membersRes.json()) as OrgMember[])
    : [];

  const invitations = invitationsRes.ok
    ? ((await invitationsRes.json()) as PendingInvitation[])
    : [];

  let loadError: string | null = null;
  if (!membersRes.ok) {
    loadError = "Failed to load members.";
  } else if (!invitationsRes.ok) {
    loadError = "Failed to load invitations.";
  }

  return { members, invitations, loadError };
});

export default function MembersPage({ loaderData }: Route.ComponentProps) {
  const { members, invitations, loadError } = loaderData;
  const { user, org } = useAppContext();
  const navigate = useNavigate();
  const revalidator = useRevalidator();

  const [showInviteModal, setShowInviteModal] = useState(false);
  const [showTransferModal, setShowTransferModal] = useState(false);
  const [transferTarget, setTransferTarget] = useState<OrgMember | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Redirect if no org or not admin
  useEffect(() => {
    if (!org) {
      navigate("/admin");
    } else if (org.role !== "admin") {
      navigate("/chat");
    }
  }, [org, navigate]);

  // Don't render if no org
  if (!org) return null;

  async function makeApiRequest(url: string, method: string, body?: object) {
    const res = await fetch(`${API_URL}${url}`, {
      method,
      credentials: "include",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const data = (await res.json()) as { error?: string };
      throw new Error(data.error || "Request failed");
    }
  }

  async function runAction(
    action: () => Promise<void>,
    successMessage: string
  ) {
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

  function handleRoleChange(member: OrgMember, newRole: string) {
    runAction(
      () =>
        makeApiRequest(ENDPOINTS.org.member(member.userId), "PATCH", {
          role: newRole,
        }),
      "Role updated"
    );
  }

  function handleRemoveMember(member: OrgMember) {
    const confirmed = confirm(`Remove ${member.name} from the firm?`);
    if (!confirmed) return;

    runAction(
      () => makeApiRequest(ENDPOINTS.org.member(member.userId), "DELETE"),
      "Member removed"
    );
  }

  function handleRevokeInvitation(invitation: PendingInvitation) {
    const confirmed = confirm(`Revoke invitation to ${invitation.email}?`);
    if (!confirmed) return;

    runAction(
      () => makeApiRequest(ENDPOINTS.org.invitation(invitation.id), "DELETE"),
      "Invitation revoked"
    );
  }

  function handleTransferClick(member: OrgMember) {
    setTransferTarget(member);
    setShowTransferModal(true);
  }

  function handleInviteSuccess() {
    setShowInviteModal(false);
    setSuccess("Invitation sent");
    revalidator.revalidate();
  }

  function handleTransferSuccess() {
    setShowTransferModal(false);
    setTransferTarget(null);
    setSuccess("Ownership transferred");
    revalidator.revalidate();
  }

  function handleTransferClose() {
    setShowTransferModal(false);
    setTransferTarget(null);
  }

  return (
    <>
      <PageLayout
        title="Members"
        actions={
          <button
            onClick={() => setShowInviteModal(true)}
            className="btn btn-primary btn-sm"
          >
            <Plus   strokeWidth={2.25}
                  size={13}
                  style={{ margin: "3px", marginLeft: "0px" }} />
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

        <MembersTable
          members={members}
          currentUserId={user.id}
          isOwner={org.isOwner}
          onRoleChange={handleRoleChange}
          onRemove={handleRemoveMember}
          onTransfer={handleTransferClick}
        />

        {invitations.length > 0 && (
          <InvitationsTable
            invitations={invitations}
            onRevoke={handleRevokeInvitation}
          />
        )}

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
            onClose={handleTransferClose}
            onSuccess={handleTransferSuccess}
          />
        )}
      </PageLayout>
    </>
  );
}

// ============================================================================
// Members Table
// ============================================================================

interface MembersTableProps {
  members: OrgMember[];
  currentUserId: string;
  isOwner: boolean;
  onRoleChange: (member: OrgMember, newRole: string) => void;
  onRemove: (member: OrgMember) => void;
  onTransfer: (member: OrgMember) => void;
}

function MembersTable({
  members,
  currentUserId,
  isOwner,
  onRoleChange,
  onRemove,
  onTransfer,
}: MembersTableProps) {
  return (
    <section className="section">
      <h2 className="text-title-3">Current Members ({members.length})</h2>

      {members.length === 0 ? (
        <div className="empty-state">No members found</div>
      ) : (
        <div className="table-wrapper">
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
                  currentUserId={currentUserId}
                  isOwner={isOwner}
                  onRoleChange={onRoleChange}
                  onRemove={onRemove}
                  onTransfer={onTransfer}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

interface MemberRowProps {
  member: OrgMember;
  currentUserId: string;
  isOwner: boolean;
  onRoleChange: (member: OrgMember, newRole: string) => void;
  onRemove: (member: OrgMember) => void;
  onTransfer: (member: OrgMember) => void;
}

function MemberRow({
  member,
  currentUserId,
  isOwner,
  onRoleChange,
  onRemove,
  onTransfer,
}: MemberRowProps) {
  const isSelf = member.userId === currentUserId;
  const canEditRole = !member.isOwner && !isSelf;
  const canTransferOwnership =
    isOwner && !member.isOwner && !isSelf && member.role === "admin";
  const canRemove = !member.isOwner && !isSelf;

  function getRoleBadgeClass() {
    if (member.isOwner) return "badge badge-owner";
    if (member.role === "admin") return "badge badge-admin";
    return "badge";
  }

  return (
    <tr>
      <td>
        <div>
          {member.name}
          {isSelf && " (you)"}
        </div>
        <div className="text-secondary">{member.email}</div>
      </td>

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
          <span className={getRoleBadgeClass()}>
            {member.isOwner ? "Owner" : member.role}
          </span>
        )}
      </td>

      <td>{new Date(member.createdAt).toLocaleDateString()}</td>

      <td>
        <div className="btn-group-td">
          {canTransferOwnership && (
            <button
              className="btn btn-sm btn-secondary"
              onClick={() => onTransfer(member)}
            >
              Transfer Ownership
            </button>
          )}
          {canRemove && (
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

// ============================================================================
// Invitations Table
// ============================================================================

interface InvitationsTableProps {
  invitations: PendingInvitation[];
  onRevoke: (invitation: PendingInvitation) => void;
}

function InvitationsTable({ invitations, onRevoke }: InvitationsTableProps) {
  return (
    <section className="section">
      <h2 className="text-title-3">
        Pending Invitations ({invitations.length})
      </h2>

      <div className="table-wrapper">
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
                onRevoke={onRevoke}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

interface InvitationRowProps {
  invitation: PendingInvitation;
  onRevoke: (invitation: PendingInvitation) => void;
}

function InvitationRow({ invitation, onRevoke }: InvitationRowProps) {
  const expiresDate = new Date(invitation.expiresAt);
  const expiresInMs = invitation.expiresAt - Date.now();
  const expiresSoon = expiresInMs < 86400000; // 24 hours

  return (
    <tr>
      <td>{invitation.email}</td>
      <td>
        <span className="badge">{invitation.role}</span>
      </td>
      <td className="text-secondary">{invitation.inviterName}</td>
      <td className="text-secondary">
        {expiresDate.toLocaleDateString()}
        {expiresSoon && " (soon)"}
      </td>
      <td style={{ textAlign: "right" }}>
        <button
          className="btn btn-sm btn-danger"
          onClick={() => onRevoke(invitation)}
        >
          Revoke
        </button>
      </td>
    </tr>
  );
}

// ============================================================================
// Invite Modal
// ============================================================================

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
      const res = await fetch(`${API_URL}${ENDPOINTS.org.invitations}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, role }),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
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

// ============================================================================
// Transfer Ownership Modal
// ============================================================================

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

  const nameMatches = confirmName === orgName;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!nameMatches) {
      setError("Name does not match");
      return;
    }

    setError(null);
    setIsSubmitting(true);

    try {
      const res = await fetch(`${API_URL}${ENDPOINTS.org.transferOwnership}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toUserId: targetMember.userId, confirmName }),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
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

        <div className="text-subhead" style={{ marginBottom: "-11px" }}>
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
              disabled={isSubmitting || !nameMatches}
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
