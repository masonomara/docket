import { useState } from "react";
import { redirect, useNavigate, useRevalidator } from "react-router";
import type { Route } from "./+types/org.settings";
import { apiFetch } from "~/lib/api";
import { API_URL } from "~/lib/auth-client";
import { FIRM_SIZES, US_STATES, PRACTICE_AREAS } from "~/lib/org-constants";
import type { SessionResponse, OrgMembership } from "~/lib/types";
import { AppLayout } from "~/components/AppLayout";
import { PageLayout } from "~/components/PageLayout";

interface DeletionPreview {
  org: { id: string; name: string } | null;
  members: number;
  invitations: number;
  orgContextChunks: number;
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

  if (!orgResponse.ok) {
    throw redirect("/dashboard");
  }

  const orgMembership = (await orgResponse.json()) as OrgMembership | null;

  if (!orgMembership?.org) {
    throw redirect("/dashboard");
  }

  return {
    user: sessionData.user,
    org: orgMembership,
  };
}

export default function SettingsPage({ loaderData }: Route.ComponentProps) {
  const { user, org } = loaderData;
  const navigate = useNavigate();
  const revalidator = useRevalidator();

  // Permission flags
  const isAdmin = org.role === "admin";
  const isOwner = org.isOwner;

  // Edit form state
  const [editName, setEditName] = useState(org.org.name);
  const [editFirmSize, setEditFirmSize] = useState(org.org.firmSize || "");
  const [editJurisdictions, setEditJurisdictions] = useState<string[]>(
    org.org.jurisdictions || []
  );
  const [editPracticeTypes, setEditPracticeTypes] = useState<string[]>(
    org.org.practiceTypes || []
  );
  const [isSaving, setIsSaving] = useState(false);

  // Check if any field has changed
  const originalJurisdictions = org.org.jurisdictions || [];
  const originalPracticeTypes = org.org.practiceTypes || [];
  const hasChanges =
    editName !== org.org.name ||
    editFirmSize !== (org.org.firmSize || "") ||
    editJurisdictions.length !== originalJurisdictions.length ||
    editJurisdictions.some((j) => !originalJurisdictions.includes(j)) ||
    editPracticeTypes.length !== originalPracticeTypes.length ||
    editPracticeTypes.some((p) => !originalPracticeTypes.includes(p));

  // Delete modal state
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deletionPreview, setDeletionPreview] =
    useState<DeletionPreview | null>(null);
  const [confirmName, setConfirmName] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);

  // Feedback state
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  /**
   * Toggle an item in a string array (add if not present, remove if present)
   */
  function toggleArrayItem(array: string[], item: string): string[] {
    if (array.includes(item)) {
      return array.filter((i) => i !== item);
    }
    return [...array, item];
  }

  async function handleSave() {
    setError(null);
    setSuccess(null);
    setIsSaving(true);

    try {
      const response = await fetch(`${API_URL}/api/org`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editName,
          firmSize: editFirmSize || undefined,
          jurisdictions: editJurisdictions,
          practiceTypes: editPracticeTypes,
        }),
      });

      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        throw new Error(data.error || "Failed to update firm");
      }

      setSuccess("Firm updated");
      revalidator.revalidate();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save";
      setError(message);
    } finally {
      setIsSaving(false);
    }
  }

  function handleCancelEdit() {
    // Reset form to original values
    setEditName(org.org.name);
    setEditFirmSize(org.org.firmSize || "");
    setEditJurisdictions(org.org.jurisdictions || []);
    setEditPracticeTypes(org.org.practiceTypes || []);
    setError(null);
  }

  async function handleShowDeleteModal() {
    setError(null);

    try {
      const response = await fetch(`${API_URL}/api/org/deletion-preview`, {
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
      const message = err instanceof Error ? err.message : "Failed to load";
      setError(message);
    }
  }

  async function handleDeleteOrg() {
    if (confirmName !== org.org.name) {
      setError("Name does not match");
      return;
    }

    setError(null);
    setIsDeleting(true);

    try {
      const response = await fetch(`${API_URL}/api/org`, {
        method: "DELETE",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmName }),
      });

      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        throw new Error(data.error || "Failed to delete firm");
      }

      navigate("/dashboard");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to delete";
      setError(message);
    } finally {
      setIsDeleting(false);
    }
  }

  function handleCloseDeleteModal() {
    setShowDeleteModal(false);
    setConfirmName("");
    setError(null);
  }

  return (
    <AppLayout user={user} org={org} currentPath="/org/settings">
      <PageLayout title="Firm Settings">
        {error && <div className="alert alert-error">{error}</div>}
        {success && <div className="alert alert-success">{success}</div>}

        {/* Firm Information Section */}
        <section>
          <h2 className="text-title-3">Firm</h2>
          <div className="form-card">
            <div className="form-group">
              <label htmlFor="orgName" className="form-label">
                Firm Name
              </label>
              <input
                id="orgName"
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                disabled={!isAdmin}
                className={`form-input${!isAdmin ? " input-disabled" : ""}`}
              />
            </div>

            <div className="form-group">
              <label htmlFor="firmSize" className="form-label">
                Firm Size
              </label>
              <select
                id="firmSize"
                value={editFirmSize}
                onChange={(e) => setEditFirmSize(e.target.value)}
                disabled={!isAdmin}
                className={`form-select${!isAdmin ? " input-disabled" : ""}`}
              >
                <option value="">Select size...</option>
                {FIRM_SIZES.map((size) => (
                  <option key={size.id} value={size.id}>
                    {size.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="form-group" style={{ gridColumn: "span 2" }}>
              <label className="form-label">Jurisdictions</label>
              <div className="chip-grid">
                {US_STATES.map((state) => {
                  const isSelected = editJurisdictions.includes(state);
                  return (
                    <button
                      key={state}
                      type="button"
                      onClick={() =>
                        isAdmin &&
                        setEditJurisdictions(
                          toggleArrayItem(editJurisdictions, state)
                        )
                      }
                      disabled={!isAdmin}
                      className={`chip ${isSelected ? "chip-selected" : ""}`}
                    >
                      {state}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="form-group" style={{ gridColumn: "span 2" }}>
              <label className="form-label">Practice Areas</label>
              <div className="chip-grid">
                {PRACTICE_AREAS.map((area) => {
                  const isSelected = editPracticeTypes.includes(area.id);
                  return (
                    <button
                      key={area.id}
                      type="button"
                      onClick={() =>
                        isAdmin &&
                        setEditPracticeTypes(
                          toggleArrayItem(editPracticeTypes, area.id)
                        )
                      }
                      disabled={!isAdmin}
                      className={`chip ${isSelected ? "chip-selected" : ""}`}
                    >
                      {area.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
          {hasChanges && (
            <div className="btn-group">
              <button
                onClick={handleCancelEdit}
                disabled={isSaving}
                className="btn btn-lg btn-secondary btn-lg-fit"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={isSaving}
                className="btn btn-lg btn-primary btn-lg-fit"
              >
                {isSaving ? "Saving..." : "Save Changes"}
              </button>
            </div>
          )}
        </section>

        {/* Danger Zone Section (Owner only) */}
        {isOwner && (
          <section>
            <h2 className="text-title-3">Danger Zone</h2>
            <div className="info-card">
              <div>
                <h3 className="text-headline">Delete Firm</h3>
                <p className="text-secondary">
                  Permanently delete this firm and all its data. This action
                  cannot be undone.
                </p>
              </div>
              <button
                onClick={handleShowDeleteModal}
                className="btn btn-sm btn-danger"
              >
                Delete Firm
              </button>
            </div>
          </section>
        )}

        {/* Delete Firm Modal */}
        {showDeleteModal && deletionPreview && (
          <div className="modal-overlay" onClick={handleCloseDeleteModal}>
            <div className="modal-content" onClick={(e) => e.stopPropagation()}>
              <h2 className="modal-title">Delete Firm</h2>

              <div
                className="alert alert-error"
                style={{ marginBottom: "-11px" }}
              >
                This will permanently delete:
              </div>

              <ul className="text-secondary text-callout">
                <li>
                  <strong>{deletionPreview.org?.name}</strong>
                </li>
                <li>{deletionPreview.members} member(s)</li>
                <li>{deletionPreview.invitations} pending invitation(s)</li>
                <li>{deletionPreview.orgContextChunks} document(s)</li>
                <li>All conversations, Clio connections, and audit logs</li>
              </ul>

              <div className="form-group">
                <label htmlFor="confirmName" className="form-label">
                  Type <strong>{org.org.name}</strong> to confirm:
                </label>
                <input
                  id="confirmName"
                  type="text"
                  value={confirmName}
                  onChange={(e) => setConfirmName(e.target.value)}
                  className="form-input"
                  placeholder="Firm name"
                />
              </div>

              {error && <div className="alert alert-error">{error}</div>}

              <div className="modal-actions">
                <button
                  onClick={handleCloseDeleteModal}
                  className="btn btn-secondary btn-lg btn-lg-fit"
                >
                  Cancel
                </button>
                <button
                  onClick={handleDeleteOrg}
                  disabled={isDeleting || confirmName !== org.org.name}
                  className="btn btn-danger btn-lg btn-lg-fit"
                >
                  {isDeleting ? "Deleting..." : "Delete Firm"}
                </button>
              </div>
            </div>
          </div>
        )}
      </PageLayout>
    </AppLayout>
  );
}
