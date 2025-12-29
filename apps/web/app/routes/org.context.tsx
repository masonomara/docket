import { useState, useRef } from "react";
import { redirect } from "react-router";
import type { Route } from "./+types/org.context";
import { apiFetch } from "~/lib/api";
import { API_URL } from "~/lib/auth-client";
import { validateFile, formatFileSize } from "~/lib/file-validation";
import type {
  SessionResponse,
  OrgMembership,
  OrgContextDocument,
} from "~/lib/types";
import { AppLayout } from "~/components/AppLayout";
import { PageLayout } from "~/components/PageLayout";
import styles from "~/styles/org-context.module.css";
import { Info, Plus } from "lucide-react";

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
  const docsResponse = await apiFetch(context, "/api/org/context", cookie);

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
   * Validate and upload a file
   */
  async function uploadFile(file: File) {
    // Validate file
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

      const response = await fetch(`${API_URL}/api/org/context`, {
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
      const response = await fetch(`${API_URL}/api/org/context/${documentId}`, {
        method: "DELETE",
        credentials: "include",
      });

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
    <AppLayout user={user} org={org} currentPath="/org/context">
      <PageLayout
        title="Knowledge Base"
        subtitle="Upload internal procedures and policies for Docket to reference when answering questions."
      >
        <section className="infoSection">
          <Info
            strokeWidth={2}
            size={16}
            style={{ marginTop: "1.5px", minHeight: "16px", minWidth: "16px" }}
          />
          <div>
            <h3 className="text-headline">
              Available to all members. Avoid uploading sensitive client data.
            </h3>
          </div>
        </section>
        {error && <div className="alert alert-error">{error}</div>}

        <section>
          <h2 className="text-title-3">Upload Documents</h2>
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
                  <Plus
                    className={styles.uploadPlus}
                    color={"var(--text-primary)"}
                  />
                  <span className={styles.uploadText}>
                    Drop file or click to upload
                  </span>
                  <span className={styles.uploadHint}>
                    PDF, Word, Excel, or text files (max 25MB)
                  </span>
                </>
              )}
            </label>
          </div>
        </section>

        {/* Documents Table */}
        <section>
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
                    <tr key={doc.id}>
                      <td>{doc.filename}</td>
                      <td>{formatFileSize(doc.size)}</td>
                      <td>{new Date(doc.uploadedAt).toLocaleDateString()}</td>
                      <td style={{ textAlign: "right" }}>
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
            </div>
          )}
        </section>
      </PageLayout>
    </AppLayout>
  );
}
