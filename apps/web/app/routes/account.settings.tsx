import { useState } from "react";
import { redirect, useNavigate } from "react-router";
import type { Route } from "./+types/account.settings";
import { apiFetch } from "~/lib/api";
import { API_URL, authClient, signOut } from "~/lib/auth-client";
import type { SessionResponse, OrgMembership } from "~/lib/types";
import { AppLayout } from "~/components/AppLayout";
import { PageLayout } from "~/components/PageLayout";

interface DeletionPreview {
  user: { id: string; email: string } | null;
  orgsOwned: number;
  orgMemberships: number;
}

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

  let orgMembership: OrgMembership | null = null;
  if (orgResponse.ok) {
    const orgData = (await orgResponse.json()) as OrgMembership | null;
    if (orgData?.org) {
      orgMembership = orgData;
    }
  }

  return {
    user: sessionData.user,
    org: orgMembership,
  };
}

export default function AccountSettingsPage({
  loaderData,
}: Route.ComponentProps) {
  const { user, org } = loaderData;
  const navigate = useNavigate();

  // Name editing state
  const [name, setName] = useState(user.name);
  const [isSaving, setIsSaving] = useState(false);
  const nameChanged = name !== user.name;

  // Modal and deletion state
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deletionPreview, setDeletionPreview] =
    useState<DeletionPreview | null>(null);
  const [confirmEmail, setConfirmEmail] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSaveName() {
    setError(null);
    setIsSaving(true);

    try {
      const response = await fetch(`${API_URL}/api/account`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });

      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        throw new Error(data.error || "Failed to update name");
      }

      // Reload to get fresh data
      window.location.reload();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to update name";
      setError(message);
    } finally {
      setIsSaving(false);
    }
  }

  function handleCancelName() {
    setName(user.name);
  }

  async function handleShowDeleteModal() {
    setError(null);

    try {
      const response = await fetch(`${API_URL}/api/account/deletion-preview`, {
        credentials: "include",
      });

      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        throw new Error(data.error || "Failed to load deletion preview");
      }

      const preview = (await response.json()) as DeletionPreview;
      setDeletionPreview(preview);
      setShowDeleteModal(true);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load preview";
      setError(message);
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
      const response = await fetch(`${API_URL}/api/account`, {
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

        // Handle special case where user owns firms
        if (data.error === "sole_owner") {
          throw new Error(
            data.message || "You must transfer ownership of your firm first"
          );
        }

        throw new Error(data.error || "Failed to delete account");
      }

      // Sign out and redirect to auth
      await authClient.signOut();
      navigate("/auth");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to delete account";
      setError(message);
    } finally {
      setIsDeleting(false);
    }
  }

  function handleCloseModal() {
    setShowDeleteModal(false);
    setConfirmEmail("");
    setError(null);
  }

  return (
    <AppLayout user={user} org={org} currentPath="/account/settings">
      <PageLayout title="Account Settings">
        {error && <div className="alert alert-error">{error}</div>}

        {/* Account Information Section */}
        <section>
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
          {nameChanged && (
            <div className="btn-group">
              <button
                onClick={handleCancelName}
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
        <section>
          <h2 className="text-title-3">Session</h2>
          <div className="info-card">
            <div>
              <h3 className="text-headline">Sign Out</h3>
              <p className="text-secondary">
                Sign out of your account on this device.
              </p>
            </div>
            <button
              onClick={() =>
                signOut().then(() => (window.location.href = "/auth"))
              }
              className="btn btn-sm btn-secondary"
            >
              Sign Out
            </button>
          </div>
        </section>

        {/* Danger Zone Section */}
        <section>
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
          <div className="modal-overlay" onClick={handleCloseModal}>
            <div className="modal-content" onClick={(e) => e.stopPropagation()}>
              <h2 className="modal-title">Delete Account</h2>

              <div
                className="alert alert-error"
                style={{ marginBottom: "-11px" }}
              >
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

              {deletionPreview.orgsOwned > 0 && (
                <div className="alert alert-error">
                  Warning: You must transfer ownership before deleting your
                  account.
                </div>
              )}

              <div className="form-group">
                <label htmlFor="confirmEmail" className="form-label">
                  Type <strong>{user.email}</strong> to confirm:
                </label>
                <input
                  id="confirmEmail"
                  type="email"
                  value={confirmEmail}
                  onChange={(e) => setConfirmEmail(e.target.value)}
                  className="form-input"
                  placeholder="Your email"
                />
              </div>

              {error && <div className="alert alert-error">{error}</div>}

              <div className="modal-actions">
                <button
                  onClick={handleCloseModal}
                  className="btn btn-secondary btn-lg btn-lg-fit"
                >
                  Cancel
                </button>
                <button
                  onClick={handleDeleteAccount}
                  disabled={isDeleting || confirmEmail !== user.email}
                  className="btn btn-danger btn-lg btn-lg-fit"
                >
                  {isDeleting ? "Deleting..." : "Delete Account"}
                </button>
              </div>
            </div>
          </div>
        )}
      </PageLayout>
    </AppLayout>
  );
}
