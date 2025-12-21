/**
 * Org Context Management
 *
 * Handles firm-specific documents that provide context for RAG.
 * Each org can upload documents (PDFs, Word docs, etc.) that get:
 * 1. Stored in R2 (original file)
 * 2. Converted to text via Workers AI
 * 3. Chunked and embedded
 * 4. Stored in D1 and Vectorize for retrieval
 */

import { Env } from "../index";
import { KB_CONFIG } from "../config/kb";
import { R2Paths } from "../storage/r2-paths";
import { chunkText, generateEmbeddings } from "./kb-builder";

// ============================================================================
// File Type Validation
// ============================================================================

/**
 * Maps MIME types to expected file extensions.
 * Only these file types can be uploaded.
 */
const ALLOWED_FILE_TYPES = new Map<string, string>([
  // Microsoft Office
  ["application/pdf", ".pdf"],
  [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".docx",
  ],
  [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xlsx",
  ],
  [
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".pptx",
  ],

  // OpenDocument
  ["application/vnd.oasis.opendocument.text", ".odt"],
  ["application/vnd.oasis.opendocument.spreadsheet", ".ods"],

  // Apple
  ["application/vnd.apple.numbers", ".numbers"],

  // Plain text formats
  ["text/markdown", ".md"],
  ["text/plain", ".txt"],
  ["text/html", ".html"],
  ["text/csv", ".csv"],
  ["application/xml", ".xml"],
  ["text/xml", ".xml"],
]);

interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Sanitizes a filename for safe storage.
 *
 * Handles:
 * - Unicode normalization attacks
 * - Control characters and null bytes
 * - Windows reserved names
 * - Path traversal attempts
 */
function sanitizeFilename(filename: string): { safe: string; error?: string } {
  // Normalize Unicode to prevent bypass via alternative encodings
  const normalized = filename.normalize("NFC");

  // Remove control characters and null bytes
  const cleaned = normalized.replace(/[\x00-\x1f\x7f]/g, "");

  // Check for path traversal (after normalization)
  if (
    cleaned.includes("..") ||
    cleaned.includes("/") ||
    cleaned.includes("\\")
  ) {
    return { safe: "", error: "Invalid filename: path traversal detected" };
  }

  // Block Windows reserved names
  const baseName = cleaned.split(".")[0].toUpperCase();
  const reserved = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/;
  if (reserved.test(baseName)) {
    return { safe: "", error: "Invalid filename: reserved name" };
  }

  // Block hidden files (starting with .)
  if (cleaned.startsWith(".")) {
    return { safe: "", error: "Invalid filename: hidden files not allowed" };
  }

  return { safe: cleaned };
}

/**
 * Validates an uploaded file before processing.
 *
 * Checks:
 * - Filename is safe (no path traversal, reserved names, etc.)
 * - File size within limits
 * - Supported MIME type
 * - Extension matches MIME type
 */
export function validateFile(
  filename: string,
  mimeType: string,
  size: number
): ValidationResult {
  // Security: sanitize filename
  const { safe: safeFilename, error: sanitizeError } = sanitizeFilename(filename);
  if (sanitizeError) {
    return { valid: false, error: sanitizeError };
  }

  // Check file size (25MB limit)
  if (size > KB_CONFIG.MAX_FILE_SIZE) {
    return { valid: false, error: "File exceeds 25MB limit" };
  }

  // Check if MIME type is supported
  const expectedExtension = ALLOWED_FILE_TYPES.get(mimeType);
  if (!expectedExtension) {
    return { valid: false, error: `Unsupported file type: ${mimeType}` };
  }

  // Verify extension matches MIME type
  const actualExtension = safeFilename
    .toLowerCase()
    .slice(safeFilename.lastIndexOf("."));
  if (actualExtension !== expectedExtension) {
    return {
      valid: false,
      error: `Extension mismatch: expected ${expectedExtension}`,
    };
  }

  return { valid: true };
}

// ============================================================================
// Text Extraction
// ============================================================================

/**
 * Extracts text content from an uploaded file.
 *
 * Plain text files are decoded directly. Other formats (PDF, DOCX, etc.)
 * are converted to markdown using Workers AI.
 */
async function extractText(
  ai: Ai,
  content: ArrayBuffer,
  mimeType: string,
  filename: string
): Promise<string> {
  // Plain text files can be decoded directly
  if (mimeType === "text/markdown" || mimeType === "text/plain") {
    return new TextDecoder().decode(content);
  }

  // Use Workers AI to convert other formats to markdown
  const conversionResults = await ai.toMarkdown([
    { name: filename, blob: new Blob([content], { type: mimeType }) },
  ]);

  const result = conversionResults[0];

  if (result.format === "error") {
    throw new Error(`Failed to extract text: ${result.error}`);
  }

  if (!result.data) {
    throw new Error(`No content extracted from ${filename}`);
  }

  return result.data;
}

// ============================================================================
// Upload Flow
// ============================================================================

interface UploadResult {
  success: boolean;
  fileId?: string;
  error?: string;
  chunksCreated?: number;
}

/**
 * Uploads a document to an org's context.
 *
 * Flow:
 * 1. Validate the file
 * 2. Store original in R2
 * 3. Extract text content
 * 4. Chunk the text
 * 5. Generate embeddings
 * 6. Store in D1 and Vectorize
 *
 * If any step fails, we clean up R2 and return an error.
 */
export async function uploadOrgContext(
  env: Env,
  orgId: string,
  filename: string,
  mimeType: string,
  content: ArrayBuffer,
  userId?: string
): Promise<UploadResult> {
  // Step 1: Validate
  const validation = validateFile(filename, mimeType, content.byteLength);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  const fileId = crypto.randomUUID();

  try {
    // Step 2: Store original file in R2
    await env.R2.put(R2Paths.orgDoc(orgId, fileId), content, {
      httpMetadata: { contentType: mimeType },
      customMetadata: { originalFilename: filename },
    });

    // Step 3: Extract text
    const text = await extractText(env.AI, content, mimeType, filename);

    // Step 4: Chunk the text
    const chunks = chunkText(text);
    if (chunks.length === 0) {
      throw new Error("No content extracted from file");
    }

    // Step 5: Generate embeddings
    const embeddings = await generateEmbeddings(env.AI, chunks);

    // Step 6a: Store chunks in D1
    const insertStatement = env.DB.prepare(`
      INSERT INTO org_context_chunks
        (id, org_id, file_id, content, source, chunk_index, uploaded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const insertOperations = chunks.map((chunkContent, index) => {
      const chunkId = `${orgId}_${fileId}_${index}`;
      return insertStatement.bind(
        chunkId,
        orgId,
        fileId,
        chunkContent,
        filename,
        index,
        userId ?? null
      );
    });

    await env.DB.batch(insertOperations);

    // Step 6b: Store vectors in Vectorize
    const vectors = chunks.map((_, index) => ({
      id: `${orgId}_${fileId}_${index}`,
      values: embeddings[index],
      metadata: {
        type: "org",
        org_id: orgId,
        source: filename,
      },
    }));

    for (let i = 0; i < vectors.length; i += KB_CONFIG.VECTORIZE_BATCH_SIZE) {
      const batch = vectors.slice(i, i + KB_CONFIG.VECTORIZE_BATCH_SIZE);
      await env.VECTORIZE.upsert(batch);
    }

    return {
      success: true,
      fileId,
      chunksCreated: chunks.length,
    };
  } catch (error) {
    // Clean up R2 on failure
    await env.R2.delete(R2Paths.orgDoc(orgId, fileId));

    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ============================================================================
// Delete Flow
// ============================================================================

/**
 * Deletes a document from an org's context.
 *
 * Removes:
 * - Vectors from Vectorize
 * - Chunks from D1
 * - Original file from R2
 */
export async function deleteOrgContext(
  env: Env,
  orgId: string,
  fileId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    // Find all chunk IDs for this file
    const chunksResult = await env.DB.prepare(
      "SELECT id FROM org_context_chunks WHERE org_id = ? AND file_id = ?"
    )
      .bind(orgId, fileId)
      .all<{ id: string }>();

    // Delete vectors from Vectorize
    if (chunksResult.results.length > 0) {
      const chunkIds = chunksResult.results.map((row) => row.id);

      for (
        let i = 0;
        i < chunkIds.length;
        i += KB_CONFIG.VECTORIZE_BATCH_SIZE
      ) {
        const batch = chunkIds.slice(i, i + KB_CONFIG.VECTORIZE_BATCH_SIZE);
        await env.VECTORIZE.deleteByIds(batch);
      }
    }

    // Delete chunks from D1
    await env.DB.prepare(
      "DELETE FROM org_context_chunks WHERE org_id = ? AND file_id = ?"
    )
      .bind(orgId, fileId)
      .run();

    // Delete original file from R2
    await env.R2.delete(R2Paths.orgDoc(orgId, fileId));

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ============================================================================
// List Files
// ============================================================================

interface OrgFile {
  fileId: string;
  source: string;
  chunkCount: number;
}

/**
 * Lists all documents uploaded to an org's context.
 */
export async function listOrgContext(
  env: Env,
  orgId: string
): Promise<OrgFile[]> {
  const result = await env.DB.prepare(
    `
    SELECT file_id, source, COUNT(*) as chunk_count
    FROM org_context_chunks
    WHERE org_id = ?
    GROUP BY file_id, source
  `
  )
    .bind(orgId)
    .all<{ file_id: string; source: string; chunk_count: number }>();

  return result.results.map((row) => ({
    fileId: row.file_id,
    source: row.source,
    chunkCount: row.chunk_count,
  }));
}
