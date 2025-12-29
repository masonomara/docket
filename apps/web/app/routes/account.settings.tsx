import { useState } from "react";
import { useNavigate } from "react-router";
import type { Route } from "./+types/account.settings";
import { API_URL, signOut } from "~/lib/auth-client";
import { ENDPOINTS } from "~/lib/api";
import { requireAuth } from "~/lib/loader-auth";
import { AppLayout } from "~/components/AppLayout";
import { PageLayout } from "~/components/PageLayout";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface DeletionPreview {
  user: { id: string; email: string } | null;
  orgsOwned: number;
  orgMemberships: number;
}

// -----------------------------------------------------------------------------
// Loader
// -----------------------------------------------------------------------------

export async function loader({ request, context }: Route.LoaderArgs) {
  return requireAuth(request, context);
}

// -----------------------------------------------------------------------------
// Page Component
// -----------------------------------------------------------------------------

export default function AccountSettingsPage({
  loaderData,
}: Route.ComponentProps) {
  const { user, org } = loaderData;
  const navigate = useNavigate();

  // Form state
  const [name, setName] = useState(user.name);
  const [isSaving, setIsSaving] = useState(false);
  const nameHasChanged = name !== user.name;

  // Delete modal state
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deletionPreview, setDeletionPreview] =
    useState<DeletionPreview | null>(null);
  const [confirmEmail, setConfirmEmail] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);

  // Feedback state
  const [error, setError] = useState<string | null>(null);

  // ---------------------------------------------------------------------------
  // Event Handlers
  // ---------------------------------------------------------------------------

  async function handleSaveName() {
    setError(null);
    setIsSaving(true);

    try {
      const response = await fetch(`${API_URL}${ENDPOINTS.account.base}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });

      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
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

  async function handleShowDeleteModal() {
    setError(null);

    try {
      const response = await fetch(
        `${API_URL}${ENDPOINTS.account.deletionPreview}`,
        { credentials: "include" }
      );

      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        throw new Error(data.error || "Failed to load deletion preview");
      }

      const preview = (await response.json()) as DeletionPreview;
      setDeletionPreview(preview);
      setShowDeleteModal(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load preview");
    }
  }

  async function handleDeleteAccount() {
    if (confirmEmail !== user.email) {
      setError("Email does not match");
      return;
    }

    setError(null);
    setIsDeleting(true);

    try {
      const response = await fetch(`${API_URL}${ENDPOINTS.account.base}`, {
        method: "DELETE",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmEmail }),
      });

      if (!response.ok) {
        const data = (await response.json()) as {
          error?: string;
          message?: string;
        };

        // Handle the special case where user is sole owner of an org
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

  function handleCloseDeleteModal() {
    setShowDeleteModal(false);
    setConfirmEmail("");
    setError(null);
  }

  async function handleSignOut() {
    await signOut();
    window.location.href = "/auth";
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <AppLayout org={org} currentPath="/account/settings">
      <PageLayout title="Account Settings">
        {error && <div className="alert alert-error">{error}</div>}

        {/* Account Details Section */}
        <section className="section">
          <h2 className="text-title-3">Account</h2>

          <div className="form-card">
            {/* Name Field */}
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

            {/* Email Field (read-only) */}
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

          {/* Save/Cancel Buttons */}
          {nameHasChanged && (
            <div className="btn-group">
              <button
                onClick={() => setName(user.name)}
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

        {/* Session Section */}
        <section className="section">
          <h2 className="text-title-3">Session</h2>

          <div className="info-card">
            <div>
              <h3 className="text-headline">Sign Out</h3>
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
        </section>

        {/* Danger Zone Section */}
        <section className="section">
          <h2 className="text-title-3">Danger Zone</h2>

          <div className="info-card">
            <div>
              <h3 className="text-headline">Delete Account</h3>
              <p className="text-secondary">
                Permanently delete your account and all associated data. This
                action cannot be undone.
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

        {/* Delete Account Modal */}
        {showDeleteModal && deletionPreview && (
          <DeleteAccountModal
            userEmail={user.email}
            deletionPreview={deletionPreview}
            confirmEmail={confirmEmail}
            onConfirmEmailChange={setConfirmEmail}
            isDeleting={isDeleting}
            error={error}
            onDelete={handleDeleteAccount}
            onClose={handleCloseDeleteModal}
          />
        )}
      </PageLayout>
    </AppLayout>
  );
}

// -----------------------------------------------------------------------------
// Delete Account Modal
// -----------------------------------------------------------------------------

interface DeleteAccountModalProps {
  userEmail: string;
  deletionPreview: DeletionPreview;
  confirmEmail: string;
  onConfirmEmailChange: (value: string) => void;
  isDeleting: boolean;
  error: string | null;
  onDelete: () => void;
  onClose: () => void;
}

function DeleteAccountModal({
  userEmail,
  deletionPreview,
  confirmEmail,
  onConfirmEmailChange,
  isDeleting,
  error,
  onDelete,
  onClose,
}: DeleteAccountModalProps) {
  const isEmailMatch = confirmEmail === userEmail;
  const hasOrgsOwned = deletionPreview.orgsOwned > 0;
  const hasOrgMemberships = deletionPreview.orgMemberships > 0;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Delete Account</h2>

        <div className="alert alert-error" style={{ marginBottom: "-11px" }}>
          This will permanently delete:
        </div>

        <ul className="text-secondary text-callout">
          <li>
            Your account (<strong>{deletionPreview.user?.email}</strong>)
          </li>
          {hasOrgsOwned && <li>{deletionPreview.orgsOwned} firm(s) you own</li>}
          {hasOrgMemberships && (
            <li>{deletionPreview.orgMemberships} firm membership(s)</li>
          )}
          <li>All your conversations and messages</li>
        </ul>

        {hasOrgsOwned && (
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
            onClick={onClose}
            className="btn btn-secondary btn-lg btn-lg-fit"
          >
            Cancel
          </button>
          <button
            onClick={onDelete}
            disabled={isDeleting || !isEmailMatch}
            className="btn btn-danger btn-lg btn-lg-fit"
          >
            {isDeleting ? "Deleting..." : "Delete Account"}
          </button>
        </div>
      </div>
    </div>
  );
}
