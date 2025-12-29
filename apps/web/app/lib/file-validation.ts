/**
 * File validation utilities for document uploads.
 * Handles MIME type checking, size limits, and filename sanitization.
 */

// ============================================================================
// Constants
// ============================================================================

export const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB

export const ALLOWED_MIME_TYPES = [
  // PDF
  "application/pdf",
  // Microsoft Office
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "application/vnd.openxmlformats-officedocument.presentationml.presentation", // .pptx
  // OpenDocument
  "application/vnd.oasis.opendocument.text", // .odt
  "application/vnd.oasis.opendocument.spreadsheet", // .ods
  // Apple
  "application/vnd.apple.numbers",
  // Plain text and markup
  "text/plain",
  "text/markdown",
  "text/html",
  "text/csv",
  "text/xml",
  "application/xml",
] as const;

// Extensions that could be used to execute code
const DANGEROUS_EXTENSIONS = new Set([
  // Windows executables
  ".exe",
  ".dll",
  ".bat",
  ".cmd",
  ".ps1",
  ".scr",
  ".vbs",
  ".wsf",
  // Unix scripts
  ".sh",
  // Server-side scripts
  ".php",
  ".jsp",
  ".asp",
  ".aspx",
  ".cgi",
  ".pl",
  ".py",
  ".rb",
  ".js",
]);

// Valid document extensions (used to detect double-extension attacks like "file.pdf.exe")
const DOCUMENT_EXTENSIONS = new Set([
  ".pdf",
  ".docx",
  ".xlsx",
  ".pptx",
  ".odt",
  ".ods",
  ".numbers",
  ".md",
  ".txt",
  ".html",
  ".csv",
  ".xml",
]);

// Windows reserved device names that can't be used as filenames
const WINDOWS_RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

// ============================================================================
// Types
// ============================================================================

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

export interface SanitizeResult {
  sanitized: string;
  error?: string;
}

// ============================================================================
// Public Functions
// ============================================================================

/**
 * Validates a file for upload.
 * Checks MIME type, file size, and filename safety.
 */
export function validateFile(file: File): ValidationResult {
  // Check MIME type
  const mimeType = file.type as (typeof ALLOWED_MIME_TYPES)[number];
  if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
    const displayType = file.type || "unknown";
    return { valid: false, error: `Unsupported file type: ${displayType}` };
  }

  // Check file size
  if (file.size > MAX_FILE_SIZE) {
    const sizeDisplay = formatFileSize(file.size);
    return { valid: false, error: `File exceeds 25MB limit (${sizeDisplay})` };
  }

  // Check filename
  const filenameResult = sanitizeFilename(file.name);
  if (filenameResult.error) {
    return { valid: false, error: filenameResult.error };
  }

  return { valid: true };
}

/**
 * Sanitizes a filename for safe storage.
 * Returns an error if the filename is malicious or invalid.
 */
export function sanitizeFilename(filename: string): SanitizeResult {
  // Block path traversal attempts
  if (hasPathTraversal(filename)) {
    return {
      sanitized: "",
      error: "Invalid filename: path traversal detected",
    };
  }

  // Clean up the filename
  let cleaned = filename;
  cleaned = removeControlCharacters(cleaned);
  cleaned = replaceSpecialCharacters(cleaned);
  cleaned = collapseUnderscores(cleaned);
  cleaned = truncateToMaxLength(cleaned);

  // Check for Windows reserved names
  const baseName = cleaned.split(".")[0];
  if (WINDOWS_RESERVED_NAMES.test(baseName)) {
    return { sanitized: "", error: "Invalid filename: reserved name" };
  }

  // Block hidden files (Unix-style dotfiles)
  if (cleaned.startsWith(".")) {
    return {
      sanitized: "",
      error: "Invalid filename: hidden files not allowed",
    };
  }

  // Check for double-extension attacks (e.g., "file.pdf.exe")
  if (hasDoubleExtensionAttack(cleaned)) {
    return {
      sanitized: "",
      error: "Invalid filename: double extensions not allowed",
    };
  }

  // Block dangerous file extensions
  if (hasDangerousExtension(cleaned)) {
    return { sanitized: "", error: "Invalid filename: dangerous extension" };
  }

  return { sanitized: cleaned };
}

/**
 * Formats a byte count as a human-readable string.
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ============================================================================
// Private Helpers
// ============================================================================

function hasPathTraversal(filename: string): boolean {
  return (
    filename.includes("..") || filename.includes("/") || filename.includes("\\")
  );
}

function removeControlCharacters(str: string): string {
  // Remove ASCII control characters (0x00-0x1F and 0x7F)
  return str.replace(/[\x00-\x1f\x7f]/g, "");
}

function replaceSpecialCharacters(str: string): string {
  // Replace anything that's not alphanumeric, dot, hyphen, underscore, or space
  return str.replace(/[^a-zA-Z0-9.\-_\s]/g, "_");
}

function collapseUnderscores(str: string): string {
  // Collapse multiple underscores or spaces into a single underscore
  return str.replace(/[_\s]+/g, "_");
}

function truncateToMaxLength(filename: string): string {
  const MAX_FILENAME_LENGTH = 255;

  if (filename.length <= MAX_FILENAME_LENGTH) {
    return filename;
  }

  // Preserve the file extension when truncating
  const lastDot = filename.lastIndexOf(".");
  const extension = lastDot >= 0 ? filename.slice(lastDot) : "";
  const maxBaseLength = MAX_FILENAME_LENGTH - extension.length;

  return filename.slice(0, maxBaseLength) + extension;
}

function hasDoubleExtensionAttack(filename: string): boolean {
  const parts = filename.toLowerCase().split(".");

  // Need at least 3 parts for a double extension (name.ext1.ext2)
  if (parts.length <= 2) {
    return false;
  }

  // Check if any middle part looks like a document or dangerous extension
  for (let i = 1; i < parts.length - 1; i++) {
    const extension = "." + parts[i];
    if (
      DOCUMENT_EXTENSIONS.has(extension) ||
      DANGEROUS_EXTENSIONS.has(extension)
    ) {
      return true;
    }
  }

  return false;
}

function hasDangerousExtension(filename: string): boolean {
  const lowerFilename = filename.toLowerCase();
  for (const ext of DANGEROUS_EXTENSIONS) {
    if (lowerFilename.endsWith(ext)) {
      return true;
    }
  }
  return false;
}
