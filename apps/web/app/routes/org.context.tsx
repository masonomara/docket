import { useState, useRef } from "react";
import { useRevalidator } from "react-router";
import type { Route } from "./+types/org.context";
import { apiFetch, ENDPOINTS } from "~/lib/api";
import { API_URL } from "~/lib/auth-client";
import { validateFile, formatFileSize } from "~/lib/file-validation";
import { requireOrgAuth } from "~/lib/loader-auth";
import type { OrgContextDocument } from "~/lib/types";
import { AppLayout } from "~/components/AppLayout";
import { PageLayout } from "~/components/PageLayout";
import styles from "~/styles/org-context.module.css";
import { Info, Plus } from "lucide-react";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const ACCEPTED_FILE_TYPES =
  ".pdf,.docx,.xlsx,.pptx,.odt,.ods,.numbers,.md,.txt,.html,.csv,.xml";

// -----------------------------------------------------------------------------
// Loader
// -----------------------------------------------------------------------------

export async function loader({ request, context }: Route.LoaderArgs) {
  const { user, org } = await requireOrgAuth(request, context, {
    requireAdmin: true,
  });

  const cookie = request.headers.get("cookie") || "";
  const docsResponse = await apiFetch(context, ENDPOINTS.org.context, cookie);

  let documents: OrgContextDocument[] = [];
  let loadError: string | null = null;

  if (docsResponse.ok) {
    documents = (await docsResponse.json()) as OrgContextDocument[];
  } else {
    loadError = "Failed to load documents.";
  }

  return { user, org, documents, loadError };
}

// -----------------------------------------------------------------------------
// Page Component
// -----------------------------------------------------------------------------

export default function DocumentsPage({ loaderData }: Route.ComponentProps) {
  const { user, org, documents: initialDocuments, loadError } = loaderData;
  const revalidator = useRevalidator();

  // Document state (local for optimistic updates)
  const [documents, setDocuments] =
    useState<OrgContextDocument[]>(initialDocuments);

  // Upload state
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Feedback state
  const [error, setError] = useState<string | null>(null);

  // ---------------------------------------------------------------------------
  // File Upload
  // ---------------------------------------------------------------------------

  async function uploadFile(file: File) {
    // Validate the file before uploading
    const validation = validateFile(file);
    if (!validation.valid) {
      setError(validation.error || "Invalid file");
      return;
    }

    setError(null);
    setIsUploading(true);
    setUploadProgress(30);

    try {
      // Create form data and upload
      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch(`${API_URL}${ENDPOINTS.org.context}`, {
        method: "POST",
        body: formData,
        credentials: "include",
      });

      setUploadProgress(80);

      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        throw new Error(data.error || "Upload failed");
      }

      // Add the new document to the list
      const newDocument = (await response.json()) as OrgContextDocument;
      setDocuments((prevDocuments) => [newDocument, ...prevDocuments]);
      setUploadProgress(100);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setIsUploading(false);

      // Reset the file input so the same file can be uploaded again
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }

  // ---------------------------------------------------------------------------
  // File Deletion
  // ---------------------------------------------------------------------------

  async function handleDelete(documentId: string, filename: string) {
    const confirmed = confirm(`Delete "${filename}"?`);
    if (!confirmed) return;

    try {
      const response = await fetch(
        `${API_URL}${ENDPOINTS.org.contextDoc(documentId)}`,
        {
          method: "DELETE",
          credentials: "include",
        }
      );

      if (!response.ok) {
        throw new Error("Failed to delete document");
      }

      // Remove the document from the list
      setDocuments((prevDocuments) =>
        prevDocuments.filter((doc) => doc.id !== documentId)
      );
    } catch {
      alert("Failed to delete document");
    }
  }

  // ---------------------------------------------------------------------------
  // Drag & Drop Handlers
  // ---------------------------------------------------------------------------

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

    const droppedFile = e.dataTransfer.files[0];
    if (!isUploading && droppedFile) {
      uploadFile(droppedFile);
    }
  }

  function handleFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      uploadFile(selectedFile);
    }
  }

  // ---------------------------------------------------------------------------
  // CSS Classes
  // ---------------------------------------------------------------------------

  function getUploadAreaClass(): string {
    let className = styles.uploadArea;

    if (isUploading) {
      className += ` ${styles.uploading}`;
    } else if (isDragOver) {
      className += ` ${styles.dragOver}`;
    }

    return className;
  }

  function getUploadLabelClass(): string {
    let className = styles.uploadLabel;

    if (isUploading) {
      className += ` ${styles.disabled}`;
    }

    return className;
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <AppLayout org={org} currentPath="/org/context">
      <PageLayout
        title="Knowledge Base"
        subtitle="Upload internal procedures and policies for Docket to reference when answering questions."
      >
        {/* Info Banner */}
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

        {/* Upload Section */}
        <section className="section">
          <h2 className="text-title-3">Upload Documents</h2>

          <div
            className={getUploadAreaClass()}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED_FILE_TYPES}
              onChange={handleFileInputChange}
              disabled={isUploading}
              id="file-input"
              className={styles.hiddenInput}
            />

            <label htmlFor="file-input" className={getUploadLabelClass()}>
              {isUploading ? (
                <UploadProgress progress={uploadProgress} />
              ) : (
                <UploadPrompt />
              )}
            </label>
          </div>
        </section>

        {/* Documents List Section */}
        <section className="section">
          <h2 className="text-title-3">
            Manage Documents ({documents.length})
          </h2>

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
                    <DocumentRow
                      key={doc.id}
                      document={doc}
                      onDelete={handleDelete}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </PageLayout>
    </AppLayout>
  );
}

// -----------------------------------------------------------------------------
// Upload Progress Component
// -----------------------------------------------------------------------------

function UploadProgress({ progress }: { progress: number }) {
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

// -----------------------------------------------------------------------------
// Upload Prompt Component
// -----------------------------------------------------------------------------

function UploadPrompt() {
  return (
    <>
      <Plus className={styles.uploadPlus} color="var(--text-primary)" />
      <span className={styles.uploadText}>Drop file or click to upload</span>
      <span className={styles.uploadHint}>
        PDF, Word, Excel, or text files (max 25MB)
      </span>
    </>
  );
}

// -----------------------------------------------------------------------------
// Document Row Component
// -----------------------------------------------------------------------------

interface DocumentRowProps {
  document: OrgContextDocument;
  onDelete: (id: string, filename: string) => void;
}

function DocumentRow({ document, onDelete }: DocumentRowProps) {
  const uploadedDate = new Date(document.uploadedAt).toLocaleDateString();

  return (
    <tr>
      <td>{document.filename}</td>
      <td>{formatFileSize(document.size)}</td>
      <td>{uploadedDate}</td>
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
