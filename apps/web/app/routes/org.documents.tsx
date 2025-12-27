import { useState, useRef } from "react";
import { redirect } from "react-router";
import type { Route } from "./+types/org.documents";
import { apiFetch } from "~/lib/api";
import { API_URL } from "~/lib/auth-client";
import type {
  SessionResponse,
  OrgMembership,
  OrgContextDocument,
} from "~/lib/types";
import { AppLayout } from "~/components/AppLayout";
import styles from "~/styles/org-documents.module.css";

// Allowed MIME types for document upload
const ALLOWED_MIME_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.apple.numbers",
  "application/xml",
  "text/markdown",
  "text/plain",
  "text/html",
  "text/csv",
  "text/xml",
];

// Maximum file size: 25MB
const MAX_FILE_SIZE = 25 * 1024 * 1024;

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

  // Fetch documents
  const docsResponse = await apiFetch(context, "/api/org/documents", cookie);

  const documents = docsResponse.ok
    ? ((await docsResponse.json()) as OrgContextDocument[])
    : [];

  return {
    user: sessionData.user,
    org: orgMembership,
    documents,
  };
}

export default function DocumentsPage({ loaderData }: Route.ComponentProps) {
  const { user, org, documents: initialDocuments } = loaderData;

  // Document state (local copy for immediate UI updates)
  const [documents, setDocuments] =
    useState<OrgContextDocument[]>(initialDocuments);

  // Upload state
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isDragOver, setIsDragOver] = useState(false);

  // Feedback state
  const [error, setError] = useState<string | null>(null);

  // File input ref for resetting after upload
  const fileInputRef = useRef<HTMLInputElement>(null);

  /**
   * Format file size for display
   */
  function formatFileSize(bytes: number): string {
    if (bytes < 1024) {
      return `${bytes} B`;
    }

    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`;
    }

    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  /**
   * Validate and upload a file
   */
  async function uploadFile(file: File) {
    // Validate file type
    if (!ALLOWED_MIME_TYPES.includes(file.type)) {
      setError("File type not supported. Use PDF, DOCX, or text files.");
      return;
    }

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      setError("File too large (max 25MB).");
      return;
    }

    setError(null);
    setIsUploading(true);
    setUploadProgress(30);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch(`${API_URL}/api/org/documents`, {
        method: "POST",
        body: formData,
        credentials: "include",
      });

      setUploadProgress(80);

      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        throw new Error(data.error || "Upload failed");
      }

      const newDocument = (await response.json()) as OrgContextDocument;

      // Add new document to the top of the list
      setDocuments((prev) => [newDocument, ...prev]);
      setUploadProgress(100);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Upload failed";
      setError(message);
    } finally {
      setIsUploading(false);

      // Reset file input
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }

  /**
   * Delete a document
   */
  async function handleDelete(documentId: string, filename: string) {
    const confirmed = confirm(`Delete "${filename}"?`);
    if (!confirmed) {
      return;
    }

    try {
      const response = await fetch(
        `${API_URL}/api/org/documents/${documentId}`,
        {
          method: "DELETE",
          credentials: "include",
        }
      );

      if (!response.ok) {
        throw new Error("Failed to delete document");
      }

      // Remove document from local state
      setDocuments((prev) => prev.filter((doc) => doc.id !== documentId));
    } catch {
      alert("Failed to delete document");
    }
  }

  /**
   * Handle file selection from input
   */
  function handleFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) {
      uploadFile(file);
    }
  }

  /**
   * Handle drag over event
   */
  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    if (!isUploading) {
      setIsDragOver(true);
    }
  }

  /**
   * Handle drag leave event
   */
  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    setIsDragOver(false);
  }

  /**
   * Handle file drop
   */
  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragOver(false);

    if (!isUploading) {
      const file = e.dataTransfer.files[0];
      if (file) {
        uploadFile(file);
      }
    }
  }

  // Build upload area CSS classes
  let uploadAreaClass = styles.uploadArea;
  if (isUploading) {
    uploadAreaClass = `${styles.uploadArea} ${styles.uploading}`;
  } else if (isDragOver) {
    uploadAreaClass = `${styles.uploadArea} ${styles.dragOver}`;
  }

  return (
    <AppLayout user={user} org={org} currentPath="/org/documents">
      <header className={styles.header}>
        <div className={styles.headerInfo}>
          <h1>Org Context Documents</h1>
          <p className={styles.description}>
            Upload your firm&apos;s internal documents for Docket to use when
            answering questions.
          </p>
        </div>
      </header>

      {error && <div className="alert alert-error">{error}</div>}

      {/* Upload Area */}
      <div
        className={uploadAreaClass}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.docx,.xlsx,.pptx,.odt,.ods,.numbers,.md,.txt,.html,.csv,.xml"
          onChange={handleFileInputChange}
          disabled={isUploading}
          id="file-input"
          className={styles.hiddenInput}
        />

        <label
          htmlFor="file-input"
          className={`${styles.uploadLabel} ${isUploading ? styles.disabled : ""}`}
        >
          {isUploading ? (
            <div className={styles.uploadProgress}>
              <div className={styles.progressBar}>
                <div
                  className={styles.progressFill}
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
              <span className={styles.progressText}>Processing...</span>
            </div>
          ) : (
            <>
              <span className={styles.uploadIcon}>+</span>
              <span className={styles.uploadText}>
                Drop a file here or click to upload
              </span>
              <span className={styles.uploadHint}>
                PDF, DOCX, XLSX, or text files (max 25MB)
              </span>
            </>
          )}
        </label>
      </div>

      {/* Documents Table */}
      <section className={styles.section}>
        <div className="section-header">
          <h2 className="section-title">
            Uploaded Documents ({documents.length})
          </h2>
        </div>

        {documents.length === 0 ? (
          <p className="empty-state">No documents uploaded yet.</p>
        ) : (
          <table className={styles.documentsTable}>
            <thead>
              <tr>
                <th>Filename</th>
                <th>Size</th>
                <th>Chunks</th>
                <th>Uploaded</th>
                <th className={styles.actionsCell}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {documents.map((doc) => (
                <tr key={doc.id}>
                  <td>{doc.filename}</td>
                  <td>{formatFileSize(doc.size)}</td>
                  <td>{doc.chunkCount}</td>
                  <td>{new Date(doc.uploadedAt).toLocaleDateString()}</td>
                  <td className={styles.actionsCell}>
                    <button
                      onClick={() => handleDelete(doc.id, doc.filename)}
                      className="btn btn-danger-outline btn-sm"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Information Section */}
      <section className={styles.infoSection}>
        <h3>How Org Context works</h3>
        <ol>
          <li>Upload a document (PDF, DOCX, Markdown, etc.)</li>
          <li>Docket extracts text and creates vector embeddings</li>
          <li>
            When users ask questions, relevant chunks are included in context
          </li>
        </ol>
        <p>
          <strong>Tip:</strong> Upload procedures, templates, and policies.
          Avoid sensitive client data.
        </p>
      </section>
    </AppLayout>
  );
}
