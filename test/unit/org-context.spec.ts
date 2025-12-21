import { describe, it, expect } from "vitest";
import { validateFile } from "../../src/services/org-context";

describe("validateFile", () => {
  // ==========================================================================
  // Valid Files
  // ==========================================================================

  describe("valid file types", () => {
    it("accepts valid PDF", () => {
      const result = validateFile("document.pdf", "application/pdf", 1000);

      expect(result.valid).toBe(true);
    });

    it("accepts valid DOCX", () => {
      const mimeType =
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      const result = validateFile("doc.docx", mimeType, 1000);

      expect(result.valid).toBe(true);
    });

    it("accepts valid XLSX", () => {
      const mimeType =
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      const result = validateFile("sheet.xlsx", mimeType, 1000);

      expect(result.valid).toBe(true);
    });

    it("accepts valid markdown", () => {
      const result = validateFile("readme.md", "text/markdown", 500);

      expect(result.valid).toBe(true);
    });

    it("accepts valid CSV", () => {
      const result = validateFile("data.csv", "text/csv", 500);

      expect(result.valid).toBe(true);
    });

    it("accepts files at exactly 25MB", () => {
      const exactLimit = 25 * 1024 * 1024;
      const result = validateFile("exact.pdf", "application/pdf", exactLimit);

      expect(result.valid).toBe(true);
    });
  });

  // ==========================================================================
  // File Size Limits
  // ==========================================================================

  describe("file size validation", () => {
    it("rejects files over 25MB", () => {
      const overLimit = 30 * 1024 * 1024;
      const result = validateFile("large.pdf", "application/pdf", overLimit);

      expect(result.valid).toBe(false);
      expect(result.error).toContain("25MB");
    });
  });

  // ==========================================================================
  // File Type Validation
  // ==========================================================================

  describe("file type validation", () => {
    it("rejects unsupported file types", () => {
      const result = validateFile("script.js", "application/javascript", 1000);

      expect(result.valid).toBe(false);
      expect(result.error).toContain("Unsupported");
    });

    it("rejects extension mismatch", () => {
      // File claims to be PDF but has .txt extension
      const result = validateFile("document.txt", "application/pdf", 1000);

      expect(result.valid).toBe(false);
      expect(result.error).toContain("mismatch");
    });
  });

  // ==========================================================================
  // Path Traversal Prevention
  // ==========================================================================

  describe("path traversal prevention", () => {
    it("rejects path traversal with ..", () => {
      const result = validateFile("../../../etc/passwd", "text/plain", 100);

      expect(result.valid).toBe(false);
      expect(result.error).toContain("path traversal");
    });

    it("rejects path traversal with forward slash", () => {
      const result = validateFile("foo/bar.txt", "text/plain", 100);

      expect(result.valid).toBe(false);
      expect(result.error).toContain("path traversal");
    });

    it("rejects path traversal with backslash", () => {
      const result = validateFile("foo\\bar.txt", "text/plain", 100);

      expect(result.valid).toBe(false);
      expect(result.error).toContain("path traversal");
    });
  });

  // ==========================================================================
  // Windows Reserved Names
  // ==========================================================================

  describe("Windows reserved name prevention", () => {
    it("rejects CON", () => {
      const result = validateFile("CON.txt", "text/plain", 100);

      expect(result.valid).toBe(false);
      expect(result.error).toContain("reserved name");
    });

    it("rejects NUL", () => {
      const result = validateFile("NUL.pdf", "application/pdf", 100);

      expect(result.valid).toBe(false);
      expect(result.error).toContain("reserved name");
    });

    it("rejects COM1", () => {
      const result = validateFile("com1.txt", "text/plain", 100);

      expect(result.valid).toBe(false);
      expect(result.error).toContain("reserved name");
    });

    it("rejects LPT1", () => {
      const result = validateFile("LPT1.md", "text/markdown", 100);

      expect(result.valid).toBe(false);
      expect(result.error).toContain("reserved name");
    });
  });

  // ==========================================================================
  // Hidden Files
  // ==========================================================================

  describe("hidden file prevention", () => {
    it("rejects files starting with dot", () => {
      const result = validateFile(".htaccess", "text/plain", 100);

      expect(result.valid).toBe(false);
      expect(result.error).toContain("hidden files");
    });

    it("rejects .env files", () => {
      const result = validateFile(".env", "text/plain", 100);

      expect(result.valid).toBe(false);
      expect(result.error).toContain("hidden files");
    });
  });

  // ==========================================================================
  // Control Character Prevention
  // ==========================================================================

  describe("control character prevention", () => {
    it("strips null bytes from filename", () => {
      const result = validateFile("doc\x00ument.pdf", "application/pdf", 100);

      // After stripping null byte, should be valid
      expect(result.valid).toBe(true);
    });

    it("strips control characters from filename", () => {
      const result = validateFile("doc\x1fument.pdf", "application/pdf", 100);

      // After stripping control chars, should be valid
      expect(result.valid).toBe(true);
    });
  });
});
