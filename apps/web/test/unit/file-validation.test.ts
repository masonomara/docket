import { describe, it, expect } from "vitest";
import {
  validateFile,
  sanitizeFilename,
  formatFileSize,
  MAX_FILE_SIZE,
  ALLOWED_MIME_TYPES,
} from "~/lib/file-validation";

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Creates a mock File object for testing.
 * The actual blob content is minimal since we only care about metadata.
 */
function createMockFile(name: string, size: number, type: string): File {
  const blob = new Blob(["x".repeat(Math.min(size, 100))], { type });
  Object.defineProperty(blob, "size", { value: size });
  Object.defineProperty(blob, "name", { value: name });
  return blob as File;
}

// ============================================================================
// validateFile Tests
// ============================================================================

describe("validateFile", () => {
  describe("valid files", () => {
    it("accepts PDF files", () => {
      const file = createMockFile("document.pdf", 1000, "application/pdf");
      expect(validateFile(file).valid).toBe(true);
    });

    it("accepts Word documents", () => {
      const docxMimeType =
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      const file = createMockFile("document.docx", 5000, docxMimeType);
      expect(validateFile(file).valid).toBe(true);
    });

    it("accepts files at exactly the size limit", () => {
      const file = createMockFile(
        "large.pdf",
        MAX_FILE_SIZE,
        "application/pdf"
      );
      expect(validateFile(file).valid).toBe(true);
    });
  });

  describe("invalid MIME types", () => {
    it("rejects executable files", () => {
      const file = createMockFile(
        "program.exe",
        1000,
        "application/x-msdownload"
      );
      const result = validateFile(file);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Unsupported");
    });

    it("rejects image files", () => {
      const file = createMockFile("photo.jpg", 2000, "image/jpeg");
      const result = validateFile(file);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Unsupported");
    });

    it("rejects files with no MIME type", () => {
      const file = createMockFile("mystery", 1000, "");
      const result = validateFile(file);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Unsupported");
    });
  });

  describe("file size limits", () => {
    it("rejects files over 25MB", () => {
      const file = createMockFile(
        "huge.pdf",
        MAX_FILE_SIZE + 1,
        "application/pdf"
      );
      const result = validateFile(file);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("exceeds");
    });
  });
});

// ============================================================================
// sanitizeFilename Tests
// ============================================================================

describe("sanitizeFilename", () => {
  describe("character cleaning", () => {
    it("replaces special characters with underscores", () => {
      const result = sanitizeFilename("doc\u00A9.pdf");
      expect(result.sanitized).toBe("doc_.pdf");
    });

    it("collapses multiple underscores into one", () => {
      const result = sanitizeFilename("file___name.pdf");
      expect(result.sanitized).toBe("file_name.pdf");
    });
  });

  describe("path traversal prevention", () => {
    it("rejects parent directory references", () => {
      const result = sanitizeFilename("../etc/passwd");
      expect(result.error).toContain("path traversal");
    });

    it("rejects forward slashes", () => {
      const result = sanitizeFilename("path/to/file.pdf");
      expect(result.error).toContain("path traversal");
    });

    it("rejects backslashes", () => {
      const result = sanitizeFilename("path\\to\\file.pdf");
      expect(result.error).toContain("path traversal");
    });
  });

  describe("double extension attacks", () => {
    it("rejects .pdf.exe pattern", () => {
      const result = sanitizeFilename("doc.pdf.exe");
      expect(result.error).toContain("double extensions");
    });

    it("rejects .exe.pdf pattern (reversed)", () => {
      const result = sanitizeFilename("malware.exe.pdf");
      expect(result.error).toContain("double extensions");
    });

    it("allows version numbers with dots", () => {
      const result = sanitizeFilename("v1.2.3.pdf");
      expect(result.error).toBeUndefined();
      expect(result.sanitized).toBe("v1.2.3.pdf");
    });
  });

  describe("filename length limits", () => {
    it("truncates long filenames while preserving extension", () => {
      const longName = "a".repeat(300) + ".pdf";
      const result = sanitizeFilename(longName);

      expect(result.sanitized.length).toBeLessThanOrEqual(255);
      expect(result.sanitized).toMatch(/\.pdf$/);
    });
  });

  describe("dangerous extensions", () => {
    it("rejects Windows executables", () => {
      const result = sanitizeFilename("program.exe");
      expect(result.error).toContain("dangerous");
    });

    it("rejects shell scripts", () => {
      const result = sanitizeFilename("script.sh");
      expect(result.error).toContain("dangerous");
    });
  });

  describe("Windows reserved names", () => {
    it("rejects CON", () => {
      const result = sanitizeFilename("CON.pdf");
      expect(result.error).toContain("reserved");
    });

    it("rejects LPT1", () => {
      const result = sanitizeFilename("LPT1.pdf");
      expect(result.error).toContain("reserved");
    });
  });

  describe("hidden files", () => {
    it("rejects dotfiles", () => {
      const result = sanitizeFilename(".htaccess");
      expect(result.error).toContain("hidden");
    });
  });
});

// ============================================================================
// formatFileSize Tests
// ============================================================================

describe("formatFileSize", () => {
  it("formats bytes", () => {
    expect(formatFileSize(500)).toBe("500 B");
  });

  it("formats kilobytes", () => {
    expect(formatFileSize(1536)).toBe("1.5 KB");
  });

  it("formats megabytes", () => {
    expect(formatFileSize(2.5 * 1024 * 1024)).toBe("2.5 MB");
  });
});

// ============================================================================
// Constants Tests
// ============================================================================

describe("constants", () => {
  it("MAX_FILE_SIZE is 25MB", () => {
    expect(MAX_FILE_SIZE).toBe(25 * 1024 * 1024);
  });

  it("ALLOWED_MIME_TYPES includes common document types", () => {
    expect(ALLOWED_MIME_TYPES).toContain("application/pdf");
    expect(ALLOWED_MIME_TYPES).toContain(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
  });
});
