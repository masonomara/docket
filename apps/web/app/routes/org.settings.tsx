import { useState } from "react";
import { useNavigate, useRevalidator } from "react-router";
import type { Route } from "./+types/org.settings";
import { API_URL } from "~/lib/auth-client";
import { ENDPOINTS } from "~/lib/api";
import { FIRM_SIZES, US_STATES, PRACTICE_AREAS } from "~/lib/org-constants";
import { orgLoader } from "~/lib/loader-auth";
import { AppLayout } from "~/components/AppLayout";
import { PageLayout } from "~/components/PageLayout";

interface DeletionPreview {
  org: { id: string; name: string } | null;
  members: number;
  invitations: number;
  orgContextChunks: number;
}

export const loader = orgLoader(({ user, org }) => ({ user, org }));

export default function SettingsPage({ loaderData }: Route.ComponentProps) {
  const { user, org } = loaderData;
  const navigate = useNavigate();
  const revalidator = useRevalidator();

  const isAdmin = org.role === "admin";
  const originalJurisdictions = org.org.jurisdictions || [];
  const originalPracticeTypes = org.org.practiceTypes || [];

  // Form state
  const [editName, setEditName] = useState(org.org.name);
  const [editFirmSize, setEditFirmSize] = useState(org.org.firmSize || "");
  const [editJurisdictions, setEditJurisdictions] = useState<string[]>(
    originalJurisdictions
  );
  const [editPracticeTypes, setEditPracticeTypes] = useState<string[]>(
    originalPracticeTypes
  );

  // UI state
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Delete modal state
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deletionPreview, setDeletionPreview] =
    useState<DeletionPreview | null>(null);
  const [confirmName, setConfirmName] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);

  // Check if form has unsaved changes
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

  function toggleArrayItem(array: string[], item: string): string[] {
    if (array.includes(item)) {
      return array.filter((i) => i !== item);
    }
    return [...array, item];
  }

  function handleJurisdictionToggle(state: string) {
    if (!isAdmin) return;
    setEditJurisdictions(toggleArrayItem(editJurisdictions, state));
  }

  function handlePracticeTypeToggle(practiceTypeId: string) {
    if (!isAdmin) return;
    setEditPracticeTypes(toggleArrayItem(editPracticeTypes, practiceTypeId));
  }

  function handleCancelChanges() {
    setEditName(org.org.name);
    setEditFirmSize(org.org.firmSize || "");
    setEditJurisdictions(originalJurisdictions);
    setEditPracticeTypes(originalPracticeTypes);
    setError(null);
  }

  async function handleSave() {
    setError(null);
    setSuccess(null);
    setIsSaving(true);

    try {
      const res = await fetch(`${API_URL}${ENDPOINTS.org.base}`, {
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

      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
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

  async function handleShowDeleteModal() {
    setError(null);

    try {
      const res = await fetch(`${API_URL}${ENDPOINTS.org.deletionPreview}`, {
        credentials: "include",
      });

      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error || "Failed to load deletion preview");
      }

      const preview = (await res.json()) as DeletionPreview;
      setDeletionPreview(preview);
      setShowDeleteModal(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    }
  }

  function handleCloseDeleteModal() {
    setShowDeleteModal(false);
    setConfirmName("");
    setError(null);
  }

  async function handleDeleteOrg() {
    if (confirmName !== org.org.name) {
      setError("Name does not match");
      return;
    }

    setError(null);
    setIsDeleting(true);

    try {
      const res = await fetch(`${API_URL}${ENDPOINTS.org.base}`, {
        method: "DELETE",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmName }),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error || "Failed to delete firm");
      }

      navigate("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete");
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <AppLayout org={org} currentPath="/org/settings">
      <PageLayout title="Firm Settings">
        {error && <div className="alert alert-error">{error}</div>}
        {success && <div className="alert alert-success">{success}</div>}

        <FirmDetailsSection
          name={editName}
          firmSize={editFirmSize}
          jurisdictions={editJurisdictions}
          practiceTypes={editPracticeTypes}
          isAdmin={isAdmin}
          onNameChange={setEditName}
          onFirmSizeChange={setEditFirmSize}
          onJurisdictionToggle={handleJurisdictionToggle}
          onPracticeTypeToggle={handlePracticeTypeToggle}
        />

        {hasChanges && (
          <div className="btn-group">
            <button
              onClick={handleCancelChanges}
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

        {org.isOwner && (
          <DangerZoneSection onDeleteClick={handleShowDeleteModal} />
        )}

        {showDeleteModal && deletionPreview && (
          <DeleteFirmModal
            orgName={org.org.name}
            deletionPreview={deletionPreview}
            confirmName={confirmName}
            isDeleting={isDeleting}
            error={error}
            onConfirmNameChange={setConfirmName}
            onConfirm={handleDeleteOrg}
            onCancel={handleCloseDeleteModal}
          />
        )}
      </PageLayout>
    </AppLayout>
  );
}

// ============================================================================
// Firm Details Section
// ============================================================================

interface FirmDetailsSectionProps {
  name: string;
  firmSize: string;
  jurisdictions: string[];
  practiceTypes: string[];
  isAdmin: boolean;
  onNameChange: (value: string) => void;
  onFirmSizeChange: (value: string) => void;
  onJurisdictionToggle: (state: string) => void;
  onPracticeTypeToggle: (practiceTypeId: string) => void;
}

function FirmDetailsSection({
  name,
  firmSize,
  jurisdictions,
  practiceTypes,
  isAdmin,
  onNameChange,
  onFirmSizeChange,
  onJurisdictionToggle,
  onPracticeTypeToggle,
}: FirmDetailsSectionProps) {
  const inputDisabledClass = isAdmin ? "" : " input-disabled";

  return (
    <section className="section">
      <h2 className="text-title-3">Firm</h2>

      <div className="form-card">
        <div className="form-group">
          <label htmlFor="orgName" className="form-label">
            Firm Name
          </label>
          <input
            id="orgName"
            type="text"
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            disabled={!isAdmin}
            className={`form-input${inputDisabledClass}`}
          />
        </div>

        <div className="form-group">
          <label htmlFor="firmSize" className="form-label">
            Firm Size
          </label>
          <select
            id="firmSize"
            value={firmSize}
            onChange={(e) => onFirmSizeChange(e.target.value)}
            disabled={!isAdmin}
            className={`form-select${inputDisabledClass}`}
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
            {US_STATES.map((state) => (
              <button
                key={state}
                type="button"
                onClick={() => onJurisdictionToggle(state)}
                disabled={!isAdmin}
                className={`chip${jurisdictions.includes(state) ? " chip-selected" : ""}`}
              >
                {state}
              </button>
            ))}
          </div>
        </div>

        <div className="form-group" style={{ gridColumn: "span 2" }}>
          <label className="form-label">Practice Areas</label>
          <div className="chip-grid">
            {PRACTICE_AREAS.map((area) => (
              <button
                key={area.id}
                type="button"
                onClick={() => onPracticeTypeToggle(area.id)}
                disabled={!isAdmin}
                className={`chip${practiceTypes.includes(area.id) ? " chip-selected" : ""}`}
              >
                {area.label}
              </button>
            ))}
          </div>
        </div>
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
          <h3 className="text-headline">Delete Firm</h3>
          <p className="text-secondary">
            Permanently delete this firm and all its data. This action cannot be
            undone.
          </p>
        </div>
        <button onClick={onDeleteClick} className="btn btn-sm btn-danger">
          Delete Firm
        </button>
      </div>
    </section>
  );
}

// ============================================================================
// Delete Firm Modal
// ============================================================================

interface DeleteFirmModalProps {
  orgName: string;
  deletionPreview: DeletionPreview;
  confirmName: string;
  isDeleting: boolean;
  error: string | null;
  onConfirmNameChange: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

function DeleteFirmModal({
  orgName,
  deletionPreview,
  confirmName,
  isDeleting,
  error,
  onConfirmNameChange,
  onConfirm,
  onCancel,
}: DeleteFirmModalProps) {
  const nameMatches = confirmName === orgName;

  return (
    <div className="modal-overlay" onClick={onCancel}>
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
            onClick={onCancel}
            className="btn btn-secondary btn-lg btn-lg-fit"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={isDeleting || !nameMatches}
            className="btn btn-danger btn-lg btn-lg-fit"
          >
            {isDeleting ? "Deleting..." : "Delete Firm"}
          </button>
        </div>
      </div>
    </div>
  );
}
