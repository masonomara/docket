import { useState, useRef } from "react";
import { useRevalidator } from "react-router";
import type { Route } from "./+types/org.context";
import { ENDPOINTS } from "~/lib/api";
import { API_URL } from "~/lib/auth-client";
import { validateFile, formatFileSize } from "~/lib/file-validation";
import { orgLoader } from "~/lib/loader-auth";
import type { OrgContextDocument } from "~/lib/types";
import { AppLayout } from "~/components/AppLayout";
import { PageLayout } from "~/components/PageLayout";
import styles from "~/styles/org-context.module.css";
import { FilePlusCorner, FileUp, Info, Plus } from "lucide-react";

const ACCEPTED_FILE_TYPES =
  ".pdf,.docx,.xlsx,.pptx,.odt,.ods,.numbers,.md,.txt,.html,.csv,.xml";

export const loader = orgLoader(
  async ({ user, org, fetch }) => {
    const res = await fetch(ENDPOINTS.org.context);

    const documents = res.ok
      ? ((await res.json()) as OrgContextDocument[])
      : [];

    const loadError = res.ok ? null : "Failed to load documents.";

    return { user, org, documents, loadError };
  },
  { requireAdmin: true }
);

export default function DocumentsPage({ loaderData }: Route.ComponentProps) {
  const { user, org, documents: initialDocuments, loadError } = loaderData;
  const revalidator = useRevalidator();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [documents, setDocuments] =
    useState<OrgContextDocument[]>(initialDocuments);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isDragOver, setIsDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function uploadFile(file: File) {
    const validation = validateFile(file);
    if (!validation.valid) {
      setError(validation.error || "Invalid file");
      return;
    }

    setError(null);
    setIsUploading(true);
    setUploadProgress(30);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch(`${API_URL}${ENDPOINTS.org.context}`, {
        method: "POST",
        body: formData,
        credentials: "include",
      });

      setUploadProgress(80);

      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error || "Upload failed");
      }

      const newDoc = (await res.json()) as OrgContextDocument;
      setDocuments((prev) => [newDoc, ...prev]);
      setUploadProgress(100);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }

  async function handleDelete(documentId: string, filename: string) {
    const confirmed = confirm(`Delete "${filename}"?`);
    if (!confirmed) return;

    try {
      const res = await fetch(
        `${API_URL}${ENDPOINTS.org.contextDoc(documentId)}`,
        {
          method: "DELETE",
          credentials: "include",
        }
      );

      if (!res.ok) {
        throw new Error("Failed to delete document");
      }

      setDocuments((prev) => prev.filter((doc) => doc.id !== documentId));
    } catch {
      alert("Failed to delete document");
    }
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    if (!isUploading) {
      setIsDragOver(true);
    }
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    setIsDragOver(false);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragOver(false);

    const file = e.dataTransfer.files[0];
    if (!isUploading && file) {
      uploadFile(file);
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) {
      uploadFile(file);
    }
  }

  function getUploadAreaClassName() {
    let className = styles.uploadArea;
    if (isUploading) {
      className += ` ${styles.uploading}`;
    } else if (isDragOver) {
      className += ` ${styles.dragOver}`;
    }
    return className;
  }

  function getUploadLabelClassName() {
    let className = styles.uploadLabel;
    if (isUploading) {
      className += ` ${styles.disabled}`;
    }
    return className;
  }

  return (
    <AppLayout org={org} currentPath="/org/context">
      <PageLayout
        title="Knowledge Base"
        subtitle="Upload internal procedures and policies for Docket to reference when answering questions."
      >
        <InfoBanner />

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

        <section className="section">
          <h2 className="text-title-3">Upload Documents</h2>

          <div
            className={getUploadAreaClassName()}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED_FILE_TYPES}
              onChange={handleFileChange}
              disabled={isUploading}
              id="file-input"
              className={styles.hiddenInput}
            />

            <label htmlFor="file-input" className={getUploadLabelClassName()}>
              {isUploading ? (
                <UploadProgressIndicator progress={uploadProgress} />
              ) : (
                <UploadPrompt />
              )}
            </label>
          </div>
        </section>

        <DocumentsTable documents={documents} onDelete={handleDelete} />
      </PageLayout>
    </AppLayout>
  );
}

// ============================================================================
// Helper Components
// ============================================================================

function InfoBanner() {
  return (
    <section className="section infoSection">
      <Info
        strokeWidth={2.25}
        size={16}
        style={{ marginTop: "1.5px", minHeight: "16px", minWidth: "16px" }}
      />
      <div>
        <h3 className="text-headline">
          Available to all members. Avoid uploading sensitive client data.
        </h3>
      </div>
    </section>
  );
}

function UploadPrompt() {
  return (
    <>
      <FileUp strokeWidth={1.33} className={styles.uploadPlus} color="var(--text-primary)" />
      <span className={styles.uploadText}>Drag or click to upload</span>
      <span className={styles.uploadHint}>
        PDF, Word, Excel, or text files (max 25MB)
      </span>
    </>
  );
}

interface UploadProgressIndicatorProps {
  progress: number;
}

function UploadProgressIndicator({ progress }: UploadProgressIndicatorProps) {
  return (
    <div className={styles.uploadProgress}>
      <div className={styles.progressBar}>
        <div
          className={styles.progressFill}
          style={{ width: `${progress}%` }}
        />
      </div>
      <span className={styles.progressText}>Processing...</span>
    </div>
  );
}

// ============================================================================
// Documents Table
// ============================================================================

interface DocumentsTableProps {
  documents: OrgContextDocument[];
  onDelete: (documentId: string, filename: string) => void;
}

function DocumentsTable({ documents, onDelete }: DocumentsTableProps) {
  return (
    <section className="section">
      <h2 className="text-title-3">Manage Documents ({documents.length})</h2>

      {documents.length === 0 ? (
        <p className="empty-state">No documents uploaded yet.</p>
      ) : (
        <div className="tableWrapper">
          <table className="table">
            <thead>
              <tr>
                <th>Filename</th>
                <th>Size</th>
                <th>Uploaded</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {documents.map((doc) => (
                <DocumentRow key={doc.id} document={doc} onDelete={onDelete} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

interface DocumentRowProps {
  document: OrgContextDocument;
  onDelete: (documentId: string, filename: string) => void;
}

function DocumentRow({ document, onDelete }: DocumentRowProps) {
  const uploadDate = new Date(document.uploadedAt).toLocaleDateString();

  return (
    <tr>
      <td>{document.filename}</td>
      <td>{formatFileSize(document.size)}</td>
      <td>{uploadDate}</td>
      <td style={{ textAlign: "right" }}>
        <button
          onClick={() => onDelete(document.id, document.filename)}
          className="btn btn-danger-outline btn-sm"
        >
          Delete
        </button>
      </td>
    </tr>
  );
}
