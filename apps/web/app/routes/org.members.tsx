import { useState } from "react";
import { redirect, useRevalidator } from "react-router";
import type { Route } from "./+types/org.members";
import { apiFetch } from "~/lib/api";
import { API_URL } from "~/lib/auth-client";
import type {
  SessionResponse,
  OrgMembership,
  OrgMember,
  PendingInvitation,
} from "~/lib/types";
import { AppLayout } from "~/components/AppLayout";
import { PageLayout } from "~/components/PageLayout";
import { Plus } from "lucide-react";

export async function loader({ request, context }: Route.LoaderArgs) {
  const cookie = request.headers.get("cookie") || "";

  // Check if user is logged in
  const sessionResponse = await apiFetch(
    context,
    "/api/auth/get-session",
    cookie
  );

  if (!sessionResponse.ok) {
    throw redirect("/auth");
  }

  const sessionData = (await sessionResponse.json()) as SessionResponse | null;

  if (!sessionData?.user) {
    throw redirect("/auth");
  }

  // Fetch user's organization membership
  const orgResponse = await apiFetch(context, "/api/user/org", cookie);

  if (!orgResponse.ok) {
    throw redirect("/dashboard");
  }

  const orgMembership = (await orgResponse.json()) as OrgMembership | null;

  // Only admins can access this page
  if (!orgMembership?.org || orgMembership.role !== "admin") {
    throw redirect("/dashboard");
  }

  // Fetch members and invitations in parallel
  const [membersResponse, invitationsResponse] = await Promise.all([
    apiFetch(context, "/api/org/members", cookie),
    apiFetch(context, "/api/org/invitations", cookie),
  ]);

  const members = membersResponse.ok
    ? ((await membersResponse.json()) as OrgMember[])
    : [];

  const invitations = invitationsResponse.ok
    ? ((await invitationsResponse.json()) as PendingInvitation[])
    : [];

  return {
    user: sessionData.user,
    org: orgMembership,
    members,
    invitations,
  };
}

export default function MembersPage({ loaderData }: Route.ComponentProps) {
  const { user, org, members, invitations } = loaderData;
  const revalidator = useRevalidator();

  // Modal state
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [showTransferModal, setShowTransferModal] = useState(false);
  const [transferTarget, setTransferTarget] = useState<OrgMember | null>(null);

  // Feedback state
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  /**
   * Make an API request to the given URL
   */
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

  /**
   * Execute an action and handle success/error states
   */
  async function executeAction(
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
      const message = err instanceof Error ? err.message : "Action failed";
      setError(message);
    }
  }

  async function handleRoleChange(member: OrgMember, newRole: string) {
    await executeAction(
      () =>
        makeApiRequest(`/api/org/members/${member.userId}`, "PATCH", {
          role: newRole,
        }),
      "Role updated"
    );
  }

  async function handleRemoveMember(member: OrgMember) {
    const confirmed = confirm(`Remove ${member.name} from the firm?`);
    if (!confirmed) {
      return;
    }

    await executeAction(
      () => makeApiRequest(`/api/org/members/${member.userId}`, "DELETE"),
      "Member removed"
    );
  }

  async function handleRevokeInvitation(invitation: PendingInvitation) {
    const confirmed = confirm(`Revoke invitation to ${invitation.email}?`);
    if (!confirmed) {
      return;
    }

    await executeAction(
      () => makeApiRequest(`/api/org/invitations/${invitation.id}`, "DELETE"),
      "Invitation revoked"
    );
  }

  function handleOpenTransferModal(member: OrgMember) {
    setTransferTarget(member);
    setShowTransferModal(true);
  }

  function handleCloseTransferModal() {
    setShowTransferModal(false);
    setTransferTarget(null);
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

  return (
    <AppLayout user={user} org={org} currentPath="/org/members">
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
        {error && <div className="alert alert-error">{error}</div>}
        {success && <div className="alert alert-success">{success}</div>}

        {/* Current Members Section */}
        <section>
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
                  {members.map((member) => {
                    const isSelf = member.userId === user.id;
                    const canEditRole = !member.isOwner && !isSelf;
                    const canTransferOwnership =
                      org.isOwner &&
                      !member.isOwner &&
                      !isSelf &&
                      member.role === "admin";

                    return (
                      <tr key={member.id}>
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
                              onChange={(e) =>
                                handleRoleChange(member, e.target.value)
                              }
                              style={{
                                width: "auto",
                                padding: "0.25rem 0.5rem",
                              }}
                            >
                              <option value="admin">Admin</option>
                              <option value="member">Member</option>
                            </select>
                          ) : (
                            <RoleBadge
                              role={member.role}
                              isOwner={member.isOwner}
                            />
                          )}
                        </td>
                        <td>
                          {new Date(member.createdAt).toLocaleDateString()}
                        </td>
                        <td>
                          <div className="btn-group">
                            {canTransferOwnership && (
                              <button
                                className="btn-primary"
                                onClick={() => handleOpenTransferModal(member)}
                              >
                                Transfer Ownership
                              </button>
                            )}
                            {canEditRole && (
                              <button
                                className="btn btn-sm btn-danger"
                                onClick={() => handleRemoveMember(member)}
                              >
                                Remove
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Pending Invitations Section */}
        {invitations.length > 0 && (
          <section>
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
                  {invitations.map((invitation) => {
                    const expiresAt = new Date(invitation.expiresAt);
                    const expiringsSoon =
                      invitation.expiresAt - Date.now() < 24 * 60 * 60 * 1000;

                    return (
                      <tr key={invitation.id}>
                        <td>{invitation.email}</td>
                        <td>
                          <span className="badge">{invitation.role}</span>
                        </td>
                        <td className="text-secondary">
                          {invitation.inviterName}
                        </td>
                        <td className="text-secondary">
                          {expiresAt.toLocaleDateString()}
                          {expiringsSoon && " (soon)"}
                        </td>
                        <td>
                          <button
                            className="btn-primary btn-primary-danger"
                            onClick={() => handleRevokeInvitation(invitation)}
                          >
                            Revoke
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* Invite Modal */}
        {showInviteModal && (
          <InviteModal
            onClose={() => setShowInviteModal(false)}
            onSuccess={handleInviteSuccess}
          />
        )}

        {/* Transfer Ownership Modal */}
        {showTransferModal && transferTarget && (
          <TransferOwnershipModal
            targetMember={transferTarget}
            orgName={org.org.name}
            onClose={handleCloseTransferModal}
            onSuccess={handleTransferSuccess}
          />
        )}
      </PageLayout>
    </AppLayout>
  );
}

interface RoleBadgeProps {
  role: string;
  isOwner: boolean;
}

function RoleBadge({ role, isOwner }: RoleBadgeProps) {
  let badgeClass = "badge";

  if (isOwner) {
    badgeClass = "badge badge-owner";
  } else if (role === "admin") {
    badgeClass = "badge badge-admin";
  }

  const displayText = isOwner ? "Owner" : role;

  return <span className={badgeClass}>{displayText}</span>;
}

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
      const response = await fetch(`${API_URL}/api/org/invitations`, {
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
      const message =
        err instanceof Error ? err.message : "Failed to send invitation";
      setError(message);
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

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (confirmName !== orgName) {
      setError("Name does not match");
      return;
    }

    setIsSubmitting(true);

    try {
      const response = await fetch(`${API_URL}/api/org/transfer-ownership`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          toUserId: targetMember.userId,
          confirmName,
        }),
      });

      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        throw new Error(data.error || "Failed to transfer ownership");
      }

      onSuccess();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to transfer ownership";
      setError(message);
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
              disabled={isSubmitting || confirmName !== orgName}
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
