import { useState } from "react";
import { useNavigate } from "react-router";
import type { Route } from "./+types/account.settings";
import { API_URL, signOut } from "~/lib/auth-client";
import { ENDPOINTS } from "~/lib/api";
import { protectedLoader } from "~/lib/loader-auth";
import { AppLayout } from "~/components/AppLayout";
import { PageLayout } from "~/components/PageLayout";

interface DeletionPreview {
  user: { id: string; email: string } | null;
  orgsOwned: number;
  orgMemberships: number;
}

export const loader = protectedLoader(({ user, org }) => ({ user, org }));

export default function AccountSettingsPage({
  loaderData,
}: Route.ComponentProps) {
  const { user, org } = loaderData;
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
    <AppLayout org={org} currentPath="/account/settings">
      <PageLayout title="Account Settings">
        {error && <div className="alert alert-error">{error}</div>}

        <AccountSection
          name={name}
          email={user.email}
          hasChanges={hasNameChanged}
          isSaving={isSaving}
          onNameChange={setName}
          onSave={handleSaveName}
          onCancel={handleCancelNameChange}
        />

        <SessionSection onSignOut={handleSignOut} />

        <DangerZoneSection onDeleteClick={handleShowDeleteModal} />

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
    </AppLayout>
  );
}

// ============================================================================
// Account Section
// ============================================================================

interface AccountSectionProps {
  name: string;
  email: string;
  hasChanges: boolean;
  isSaving: boolean;
  onNameChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}

function AccountSection({
  name,
  email,
  hasChanges,
  isSaving,
  onNameChange,
  onSave,
  onCancel,
}: AccountSectionProps) {
  return (
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
            onChange={(e) => onNameChange(e.target.value)}
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
            value={email}
            disabled
            className="form-input input-disabled"
          />
        </div>
      </div>

      {hasChanges && (
        <div className="btn-group">
          <button
            onClick={onCancel}
            disabled={isSaving}
            className="btn btn-lg btn-secondary btn-lg-fit"
          >
            Cancel
          </button>
          <button
            onClick={onSave}
            disabled={isSaving}
            className="btn btn-lg btn-primary btn-lg-fit"
          >
            {isSaving ? "Saving..." : "Save Changes"}
          </button>
        </div>
      )}
    </section>
  );
}

// ============================================================================
// Session Section
// ============================================================================

interface SessionSectionProps {
  onSignOut: () => void;
}

function SessionSection({ onSignOut }: SessionSectionProps) {
  return (
    <section className="section">
      <h2 className="text-title-3">Session</h2>

      <div className="info-card">
        <div>
          <h3 className="text-headline">Sign Out</h3>
          <p className="text-secondary">
            Sign out of your account on this device.
          </p>
        </div>
        <button onClick={onSignOut} className="btn btn-sm btn-secondary">
          Sign Out
        </button>
      </div>
    </section>
  );
}

// ============================================================================
// Danger Zone Section
// ============================================================================

interface DangerZoneSectionProps {
  onDeleteClick: () => void;
}

function DangerZoneSection({ onDeleteClick }: DangerZoneSectionProps) {
  return (
    <section className="section">
      <h2 className="text-title-3">Danger Zone</h2>

      <div className="info-card">
        <div>
          <h3 className="text-headline">Delete Account</h3>
          <p className="text-secondary">
            Permanently delete your account and all associated data. This action
            cannot be undone.
          </p>
        </div>
        <button onClick={onDeleteClick} className="btn btn-sm btn-danger">
          Delete Account
        </button>
      </div>
    </section>
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
        <h2 className="modal-title">Delete Account</h2>

        <div className="alert alert-error" style={{ marginBottom: "-11px" }}>
          This will permanently delete:
        </div>

        <ul className="text-secondary text-callout">
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
