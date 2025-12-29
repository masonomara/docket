import { useState } from "react";
import { useNavigate, useRevalidator } from "react-router";
import type { Route } from "./+types/org.settings";
import { API_URL } from "~/lib/auth-client";
import { ENDPOINTS } from "~/lib/api";
import { FIRM_SIZES, US_STATES, PRACTICE_AREAS } from "~/lib/org-constants";
import { requireOrgAuth } from "~/lib/loader-auth";
import { AppLayout } from "~/components/AppLayout";
import { PageLayout } from "~/components/PageLayout";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface DeletionPreview {
  org: { id: string; name: string } | null;
  members: number;
  invitations: number;
  orgContextChunks: number;
}

// -----------------------------------------------------------------------------
// Loader
// -----------------------------------------------------------------------------

export async function loader({ request, context }: Route.LoaderArgs) {
  return requireOrgAuth(request, context);
}

// -----------------------------------------------------------------------------
// Page Component
// -----------------------------------------------------------------------------

export default function SettingsPage({ loaderData }: Route.ComponentProps) {
  const { user, org } = loaderData;
  const navigate = useNavigate();
  const revalidator = useRevalidator();

  // Permissions
  const isAdmin = org.role === "admin";
  const isOwner = org.isOwner;

  // Form state
  const [editName, setEditName] = useState(org.org.name);
  const [editFirmSize, setEditFirmSize] = useState(org.org.firmSize || "");
  const [editJurisdictions, setEditJurisdictions] = useState<string[]>(
    org.org.jurisdictions || []
  );
  const [editPracticeTypes, setEditPracticeTypes] = useState<string[]>(
    org.org.practiceTypes || []
  );
  const [isSaving, setIsSaving] = useState(false);

  // Delete modal state
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deletionPreview, setDeletionPreview] =
    useState<DeletionPreview | null>(null);
  const [confirmName, setConfirmName] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);

  // Feedback state
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // ---------------------------------------------------------------------------
  // Change Detection
  // ---------------------------------------------------------------------------

  const originalJurisdictions = org.org.jurisdictions || [];
  const originalPracticeTypes = org.org.practiceTypes || [];

  const hasNameChanged = editName !== org.org.name;
  const hasFirmSizeChanged = editFirmSize !== (org.org.firmSize || "");
  const hasJurisdictionsChanged =
    editJurisdictions.length !== originalJurisdictions.length ||
    editJurisdictions.some((j) => !originalJurisdictions.includes(j));
  const hasPracticeTypesChanged =
    editPracticeTypes.length !== originalPracticeTypes.length ||
    editPracticeTypes.some((p) => !originalPracticeTypes.includes(p));

  const hasChanges =
    hasNameChanged ||
    hasFirmSizeChanged ||
    hasJurisdictionsChanged ||
    hasPracticeTypesChanged;

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function toggleArrayItem(array: string[], item: string): string[] {
    if (array.includes(item)) {
      return array.filter((i) => i !== item);
    }
    return [...array, item];
  }

  // ---------------------------------------------------------------------------
  // Event Handlers
  // ---------------------------------------------------------------------------

  async function handleSave() {
    setError(null);
    setSuccess(null);
    setIsSaving(true);

    try {
      const response = await fetch(`${API_URL}${ENDPOINTS.org.base}`, {
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
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setIsSaving(false);
    }
  }

  function handleCancelEdit() {
    setEditName(org.org.name);
    setEditFirmSize(org.org.firmSize || "");
    setEditJurisdictions(org.org.jurisdictions || []);
    setEditPracticeTypes(org.org.practiceTypes || []);
    setError(null);
  }

  async function handleShowDeleteModal() {
    setError(null);

    try {
      const response = await fetch(
        `${API_URL}${ENDPOINTS.org.deletionPreview}`,
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
      setError(err instanceof Error ? err.message : "Failed to load");
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
      const response = await fetch(`${API_URL}${ENDPOINTS.org.base}`, {
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
      setError(err instanceof Error ? err.message : "Failed to delete");
    } finally {
      setIsDeleting(false);
    }
  }

  function handleCloseDeleteModal() {
    setShowDeleteModal(false);
    setConfirmName("");
    setError(null);
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <AppLayout org={org} currentPath="/org/settings">
      <PageLayout title="Firm Settings">
        {error && <div className="alert alert-error">{error}</div>}
        {success && <div className="alert alert-success">{success}</div>}

        {/* Firm Details Section */}
        <section className="section">
          <h2 className="text-title-3">Firm</h2>

          <div className="form-card">
            {/* Firm Name */}
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

            {/* Firm Size */}
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

            {/* Jurisdictions */}
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

            {/* Practice Areas */}
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

          {/* Save/Cancel Buttons */}
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

        {/* Danger Zone - Only visible to owners */}
        {isOwner && (
          <section className="section">
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

        {/* Delete Confirmation Modal */}
        {showDeleteModal && deletionPreview && (
          <DeleteFirmModal
            orgName={org.org.name}
            deletionPreview={deletionPreview}
            confirmName={confirmName}
            onConfirmNameChange={setConfirmName}
            isDeleting={isDeleting}
            error={error}
            onDelete={handleDeleteOrg}
            onClose={handleCloseDeleteModal}
          />
        )}
      </PageLayout>
    </AppLayout>
  );
}

// -----------------------------------------------------------------------------
// Delete Firm Modal
// -----------------------------------------------------------------------------

interface DeleteFirmModalProps {
  orgName: string;
  deletionPreview: DeletionPreview;
  confirmName: string;
  onConfirmNameChange: (value: string) => void;
  isDeleting: boolean;
  error: string | null;
  onDelete: () => void;
  onClose: () => void;
}

function DeleteFirmModal({
  orgName,
  deletionPreview,
  confirmName,
  onConfirmNameChange,
  isDeleting,
  error,
  onDelete,
  onClose,
}: DeleteFirmModalProps) {
  const isNameMatch = confirmName === orgName;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Delete Firm</h2>

        <div className="alert alert-error" style={{ marginBottom: "-11px" }}>
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
            Type <strong>{orgName}</strong> to confirm:
          </label>
          <input
            id="confirmName"
            type="text"
            value={confirmName}
            onChange={(e) => onConfirmNameChange(e.target.value)}
            className="form-input"
            placeholder="Firm name"
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
            disabled={isDeleting || !isNameMatch}
            className="btn btn-danger btn-lg btn-lg-fit"
          >
            {isDeleting ? "Deleting..." : "Delete Firm"}
          </button>
        </div>
      </div>
    </div>
  );
}
