import { useState } from "react";
import { useNavigate } from "react-router";
import { API_URL, signOut } from "~/lib/auth-client";
import { ENDPOINTS } from "~/lib/api";
import { useAppContext } from "~/lib/use-app-context";
import { PageLayout } from "~/components/PageLayout";

interface DeletionPreview {
  user: { id: string; email: string } | null;
  orgsOwned: number;
  orgMemberships: number;
}

export default function AccountSettingsPage() {
  const { user, org } = useAppContext();
  const navigate = useNavigate();

  // Name editing state
  const [name, setName] = useState(user.name);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Delete modal state
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deletionPreview, setDeletionPreview] =
    useState<DeletionPreview | null>(null);
  const [confirmEmail, setConfirmEmail] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);

  const hasNameChanged = name !== user.name;

  async function handleSaveName() {
    setError(null);
    setIsSaving(true);

    try {
      const res = await fetch(`${API_URL}${ENDPOINTS.account.base}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error || "Failed to update name");
      }

      // Reload the page to reflect the updated name
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update name");
    } finally {
      setIsSaving(false);
    }
  }

  function handleCancelNameChange() {
    setName(user.name);
  }

  async function handleSignOut() {
    await signOut();
    window.location.href = "/auth";
  }

  async function handleShowDeleteModal() {
    setError(null);

    try {
      const res = await fetch(
        `${API_URL}${ENDPOINTS.account.deletionPreview}`,
        {
          credentials: "include",
        }
      );

      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error || "Failed to load deletion preview");
      }

      const preview = (await res.json()) as DeletionPreview;
      setDeletionPreview(preview);
      setShowDeleteModal(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load preview");
    }
  }

  function handleCloseDeleteModal() {
    setShowDeleteModal(false);
    setConfirmEmail("");
    setError(null);
  }

  async function handleDeleteAccount() {
    if (confirmEmail !== user.email) {
      setError("Email does not match");
      return;
    }

    setError(null);
    setIsDeleting(true);

    try {
      const res = await fetch(`${API_URL}${ENDPOINTS.account.base}`, {
        method: "DELETE",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmEmail }),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error?: string; message?: string };

        if (data.error === "sole_owner") {
          throw new Error(
            data.message || "You must transfer ownership of your firm first"
          );
        }

        throw new Error(data.error || "Failed to delete account");
      }

      await signOut();
      navigate("/auth");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete account");
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <>
      <PageLayout title="Account Settings">
        {error && <div className="alert alert-error">{error}</div>}

        <section className="section">
          <h2 className="text-title-3">Account</h2>

          <div className="form-card">
            <div className="form-group">
              <label htmlFor="name" className="form-label">
                Name
              </label>
              <input
                id="name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="form-input"
              />
            </div>

            <div className="form-group">
              <label htmlFor="email" className="form-label">
                Email
              </label>
              <input
                id="email"
                type="email"
                value={user.email}
                disabled
                className="form-input input-disabled"
              />
            </div>
          </div>

          {hasNameChanged && (
            <div className="btn-group">
              <button
                onClick={handleCancelNameChange}
                disabled={isSaving}
                className="btn btn-lg btn-secondary btn-lg-fit"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveName}
                disabled={isSaving}
                className="btn btn-lg btn-primary btn-lg-fit"
              >
                {isSaving ? "Saving..." : "Save Changes"}
              </button>
            </div>
          )}
        </section>

        <section className="section">
          <h2 className="text-title-3">Danger Zone</h2>
          <div
            className="info-card"
            style={{
              marginBottom: "-17px",
              borderBottomRightRadius: "0px",
              borderBottomLeftRadius: "0px",
            }}
          >
            <div className="info-card-content">
              <h3 className="text-subhead">Sign Out</h3>
              <p className="text-secondary">
                Sign out of your account on this device.
              </p>
            </div>
            <button
              onClick={handleSignOut}
              className="btn btn-sm btn-secondary"
            >
              Sign Out
            </button>
          </div>
          <div
            className="info-card"
            style={{ borderTopRightRadius: "0px", borderTopLeftRadius: "0px" }}
          >
            <div className="info-card-content">
              <h3 className="text-subhead">Delete Account</h3>
              <p className="text-secondary">
                Permanently delete your account and all associated data.
              </p>
            </div>
            <button
              onClick={handleShowDeleteModal}
              className="btn btn-sm btn-danger"
            >
              Delete Account
            </button>
          </div>
        </section>

        {showDeleteModal && deletionPreview && (
          <DeleteAccountModal
            userEmail={user.email}
            deletionPreview={deletionPreview}
            confirmEmail={confirmEmail}
            isDeleting={isDeleting}
            error={error}
            onConfirmEmailChange={setConfirmEmail}
            onConfirm={handleDeleteAccount}
            onCancel={handleCloseDeleteModal}
          />
        )}
      </PageLayout>
    </>
  );
}

// ============================================================================
// Delete Account Modal
// ============================================================================

interface DeleteAccountModalProps {
  userEmail: string;
  deletionPreview: DeletionPreview;
  confirmEmail: string;
  isDeleting: boolean;
  error: string | null;
  onConfirmEmailChange: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

function DeleteAccountModal({
  userEmail,
  deletionPreview,
  confirmEmail,
  isDeleting,
  error,
  onConfirmEmailChange,
  onConfirm,
  onCancel,
}: DeleteAccountModalProps) {
  const emailMatches = confirmEmail === userEmail;
  const ownsOrgs = deletionPreview.orgsOwned > 0;

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-title-3">Delete Account</h2>

        <div className="alert alert-error" style={{ marginBottom: "0px" }}>
          This action cannot be undone.
        </div>

        <ul className="text-secondary text-callout">
          <span>This will permantly delete:</span>
          <li>
            Your account (<strong>{deletionPreview.user?.email}</strong>)
          </li>
          {deletionPreview.orgsOwned > 0 && (
            <li>{deletionPreview.orgsOwned} firm(s) you own</li>
          )}
          {deletionPreview.orgMemberships > 0 && (
            <li>{deletionPreview.orgMemberships} firm membership(s)</li>
          )}
          <li>All your conversations and messages</li>
        </ul>

        {ownsOrgs && (
          <div className="alert alert-error">
            Warning: You must transfer ownership before deleting your account.
          </div>
        )}

        <div className="form-group">
          <label htmlFor="confirmEmail" className="form-label">
            Type <strong>{userEmail}</strong> to confirm:
          </label>
          <input
            id="confirmEmail"
            type="email"
            value={confirmEmail}
            onChange={(e) => onConfirmEmailChange(e.target.value)}
            className="form-input"
            placeholder="Your email"
          />
        </div>

        {error && <div className="alert alert-error">{error}</div>}

        <div className="modal-actions">
          <button
            onClick={onCancel}
            className="btn btn-secondary btn-lg btn-lg-fit"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={isDeleting || !emailMatches}
            className="btn btn-danger btn-lg btn-lg-fit"
          >
            {isDeleting ? "Deleting..." : "Delete Account"}
          </button>
        </div>
      </div>
    </div>
  );
}
